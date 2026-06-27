using ForgeFX.Core;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;
using Scalar.AspNetCore;
using System.Text.Json;

// ForgeFX.Server — an open HTTP API over the FM3 SDK. Run it on the box the FM3 is
// plugged into (PC or Raspberry Pi); a web frontend or any HTTP client drives it.
// It owns the serial port, so it can't run alongside the fm3-midi-bridge / FM3-Edit.
//
// The API is resource-oriented and named (no raw block ids / addresses in the happy path):
//   /blocks/...           static catalog (block families, parameters, type lists)
//   /device, /preset/...  live device state (preset, decoded routing grid, block params)
// Interactive docs: /scalar   ·   OpenAPI document: /openapi/v1.json

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((doc, _, _) =>
    {
        doc.Info = new OpenApiInfo
        {
            Title = "ForgeFX API",
            Version = "v1",
            Description = "Open HTTP API for Fractal FM3 (and gen-3 siblings). Read the live "
                + "routing grid, browse the block/parameter catalog, and edit parameters by name.",
        };
        return Task.CompletedTask;
    });
});

var app = builder.Build();

// Explicit --device wins; otherwise auto-detect the Fractal serial port (stable by-id path).
var configuredDevice = app.Configuration["device"];
string ResolveDevice() => configuredDevice ?? Fm3Device.AutoDetectPort() ?? "/dev/ttyACM0";
var defsDir = app.Configuration["definitions"] ?? "definitions";
var packs = Definitions.LoadDirectory(defsDir);

// slug ("amp", "vol-pan") -> block definition pack
static string Slug(string name) => name.ToLowerInvariant().Replace(' ', '-').Replace('/', '-');
var packBySlug = packs.Values.ToDictionary(p => Slug(p.Name), p => p, StringComparer.OrdinalIgnoreCase);

// block id -> display name (status dump), from fm3-blocks.json
var blockNames = new Dictionary<int, string>();
try
{
    var bj = Path.Combine(defsDir, "fm3-blocks.json");
    if (File.Exists(bj))
        foreach (var el in JsonDocument.Parse(File.ReadAllText(bj)).RootElement.GetProperty("blocks").EnumerateArray())
            blockNames[el.GetProperty("id").GetInt32()] = el.GetProperty("name").GetString() ?? "";
}
catch { /* names are best-effort */ }

var gate = new object();
Fm3Device? device = null;

// ---- live traffic monitor (ring buffer + file) ----
var monLog = new System.Collections.Concurrent.ConcurrentQueue<MonEntry>();
long monSeq = 0;
var monPath = app.Configuration["monlog"] ?? "forgefx-monitor.log";
void LogFrame(bool tx, byte func, byte[] body)
{
    var e = new MonEntry(System.Threading.Interlocked.Increment(ref monSeq),
        DateTime.Now.ToString("HH:mm:ss.fff"), tx ? "TX" : "RX", func, body.Length, Convert.ToHexString(body));
    monLog.Enqueue(e);
    while (monLog.Count > 4000) monLog.TryDequeue(out _);
    try { File.AppendAllText(monPath, $"{e.Ts} {e.Dir} f=0x{func:x2} {e.Hex}\n"); } catch { }
}

Fm3Device Dev()
{
    lock (gate)
    {
        if (device != null) return device;
        device = new Fm3Device(ResolveDevice()) { FrameLog = LogFrame };
        return device;
    }
}

// Run a device op under the port lock; if the serial handle is stale (device
// re-enumerated / unplugged), drop it so the next call re-detects and reopens.
T Locked<T>(Func<T> f)
{
    lock (gate)
    {
        try { return f(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            try { device?.Dispose(); } catch { /* already gone */ }
            device = null;
            throw;
        }
    }
}

// background loop: drain the device's unsolicited push frames into the monitor
_ = Task.Run(async () =>
{
    while (true)
    {
        try { lock (gate) { Dev().DrainIncoming(); } } catch { /* device not ready */ }
        await Task.Delay(20);
    }
});

app.MapOpenApi();
app.MapScalarApiReference(o => o.WithTitle("ForgeFX API"));

app.Logger.LogInformation("ForgeFX device port: {Port}{Mode}", ResolveDevice(),
    configuredDevice is null ? " (auto-detected)" : " (configured)");

// =====================================================================
//  System / device
// =====================================================================

app.MapGet("/healthz", () => Results.Ok(new { ok = true, device = ResolveDevice() }))
    .WithTags("System").WithSummary("Liveness probe (resolves the serial path; does not open it).");

app.MapGet("/device", () => Locked(() =>
{
    var dev = Dev();
    var fw = dev.Firmware();
    return Results.Ok(new DeviceInfo("FM3", "0x11", fw is { } f ? new FirmwareDto(f.Version, f.Build) : null, dev.PortName));
}))
    .WithTags("System").WithSummary("Device identity + firmware (auto-detected port).");

// =====================================================================
//  Catalog (static — no device needed)
// =====================================================================

ParamInfo ToParamInfo(ParamDef p) => new(
    p.Index, p.Name, p.Unit, p.Min, p.Max, p.Scale.ToString(),
    p.Type, p.Role, p.Tier, p.Group, p.Options);

// the param that selects the block's model/type (drives /types)
static ParamDef? TypeParam(BlockDef b) =>
    Array.Find(b.Params, p => p.Type == "select" && p.Options is { Count: > 0 })
    ?? Array.Find(b.Params, p => string.Equals(p.Name, "Type", StringComparison.OrdinalIgnoreCase));

app.MapGet("/blocks", () => Results.Ok(
    packBySlug.OrderBy(kv => kv.Key).Select(kv => new BlockSummary(
        kv.Key, kv.Value.Name, kv.Value.Page, kv.Value.Params.Length, TypeParam(kv.Value)?.Options?.Count ?? 0))))
    .WithTags("Catalog").WithSummary("List every block family with a definition pack.");

app.MapGet("/blocks/{slug}", (string slug) =>
    packBySlug.TryGetValue(slug, out var b)
        ? Results.Ok(new BlockDetail(Slug(b.Name), b.Name, b.Page, b.Params.Select(ToParamInfo),
            (TypeParam(b)?.Options ?? new()).Select(o => new TypeOption(o.Key, o.Value))))
        : Results.NotFound(new { error = $"no block '{slug}'" }))
    .WithTags("Catalog").WithSummary("One block family: parameters + available types.");

app.MapGet("/blocks/{slug}/params", (string slug) =>
    packBySlug.TryGetValue(slug, out var b)
        ? Results.Ok(b.Params.Select(ToParamInfo))
        : Results.NotFound(new { error = $"no block '{slug}'" }))
    .WithTags("Catalog").WithSummary("All parameters for a block family (names, units, ranges).");

app.MapGet("/blocks/{slug}/types", (string slug) =>
    packBySlug.TryGetValue(slug, out var b)
        ? Results.Ok((TypeParam(b)?.Options ?? new()).Select(o => new TypeOption(o.Key, o.Value)))
        : Results.NotFound(new { error = $"no block '{slug}'" }))
    .WithTags("Catalog").WithSummary("Available model/type names for a block (e.g. amp models).");

// =====================================================================
//  Preset + routing grid (live)
// =====================================================================

app.MapGet("/preset", () => Locked(() =>
{
    var p = Dev().QueryPreset();
    return Results.Ok(new PresetRef(p.Number, p.Name));
}))
    .WithTags("Preset").WithSummary("Current preset number + name.");

app.MapGet("/presets/{n:int}", (int n) => Locked(() =>
{
    var p = Dev().QueryPreset(n);
    return Results.Ok(new PresetRef(p.Number, p.Name));
}))
    .WithTags("Preset").WithSummary("Number + name of a stored preset.");

object GridResult(int? n)
{
    var syx = Dev().DumpPreset(n);
    if (syx.Length == 0) return Results.Problem(n is null ? "no preset data from edit buffer" : $"no data for preset {n}");
    var p = Fm3PresetCodec.Decode(syx);
    return Results.Ok(new GridDto(
        p.ModelName, p.Name, p.CrcValid, p.Rows, p.Cols,
        p.SceneNames.Where(s => s.Length > 0),
        p.Grid.Select(c => new GridCellDto(c.Row, c.Col, c.EffectId, c.Name, c.IsShunt, c.RouteFlag, c.FromRows))));
}

app.MapGet("/preset/grid", () => Locked(() => GridResult(null)))
    .WithTags("Preset").WithSummary("Real routing grid (placement + cabling) of the current edit buffer.");

app.MapGet("/presets/{n:int}/grid", (int n) => Locked(() => GridResult(n)))
    .WithTags("Preset").WithSummary("Real routing grid of a stored preset.");

// Placed blocks: grid placement + (where ids align) live bypass/channel from fn 0x13.
app.MapGet("/preset/blocks", () => Locked(() =>
{
    var syx = Dev().DumpPreset(null);
    if (syx.Length == 0) return Results.Problem("no preset data from edit buffer");
    var grid = Fm3PresetCodec.Decode(syx);
    var states = Dev().StatusDump().ToDictionary(s => s.Id, s => s);
    var placed = grid.Grid.Where(c => !c.IsShunt).Select(c =>
    {
        states.TryGetValue(c.EffectId, out var st);
        var family = c.Name.Split(' ')[0];
        return new PlacedBlock(Slug(family), c.Name, c.EffectId, c.Row, c.Col, c.FromRows,
            st == default(ValueTuple<int, bool, int>) ? null : st.Bypassed,
            st == default(ValueTuple<int, bool, int>) ? null : ((char)('A' + st.Channel)).ToString());
    });
    return Results.Ok(placed);
}))
    .WithTags("Preset").WithSummary("Blocks placed in the current preset, with position, routing, bypass, channel.");

app.MapPost("/preset/select", (SelectRequest r) => Locked(() =>
{
    Dev().SelectPreset(r.Number);
    return Results.Ok(new { ok = true, number = r.Number });
}))
    .WithTags("Preset").WithSummary("Switch the device to a preset by number.");

// =====================================================================
//  Live block parameters (named)
// =====================================================================

app.MapGet("/preset/blocks/{slug}/params", (string slug) => Locked(() =>
{
    if (!packBySlug.TryGetValue(slug, out var def)) return Results.NotFound(new { error = $"no block '{slug}'" });
    var dump = Dev().DumpPage((byte)def.Page);
    return Results.Ok(new { block = def.Name, slug, page = def.Page, named = Definitions.ReadNamed(def, dump) });
}))
    .WithTags("Parameters").WithSummary("Live, named parameter values for a placed block.");

app.MapPut("/preset/blocks/{slug}/params/{param}", (string slug, string param, SetValue body) => Locked(() =>
{
    if (!packBySlug.TryGetValue(slug, out var def)) return Results.NotFound(new { error = $"no block '{slug}'" });
    var pd = Array.Find(def.Params, p => string.Equals(p.Name, param, StringComparison.OrdinalIgnoreCase));
    if (pd is null) return Results.NotFound(new { error = $"no param '{param}' on '{slug}'" });
    // effect == page; address = [0, page, 0, index, 0]
    var addr = new byte[] { 0, (byte)def.Page, 0, (byte)pd.Index, 0 };
    var stored = Dev().SetParam((byte)def.Page, addr, (float)body.Value);
    return Results.Ok(new { ok = true, block = def.Name, param = pd.Name, stored });
}))
    .WithTags("Parameters").WithSummary("Set one parameter on a block by name (returns the device-stored value).");

// =====================================================================
//  Backup / restore
// =====================================================================

app.MapGet("/presets/{n:int}/backup", (int n) => Locked(() =>
{
    var syx = Dev().DumpPreset(n);
    return syx.Length == 0 ? Results.Problem($"no data for preset {n}")
        : Results.Bytes(syx, "application/octet-stream", $"preset-{n}.syx");
}))
    .WithTags("Backup").WithSummary("Download a stored preset as a .syx file.");

app.MapGet("/preset/backup", () => Locked(() =>
{
    var syx = Dev().DumpPreset(null);
    return syx.Length == 0 ? Results.Problem("no data from edit buffer")
        : Results.Bytes(syx, "application/octet-stream", "preset-current.syx");
}))
    .WithTags("Backup").WithSummary("Download the current edit buffer as a .syx file.");

app.MapPost("/presets/restore", async (HttpRequest req) =>
{
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    var syx = ms.ToArray();
    return Locked(() => { Dev().SendPreset(syx); return Results.Ok(new { ok = true, bytes = syx.Length }); });
})
    .WithTags("Backup").WithSummary("Restore a preset by uploading its raw .syx bytes.");

// =====================================================================
//  Debug / low-level device probing (advanced, unstable)
// =====================================================================

app.MapGet("/debug/dump/{page:int}", (int page) => Locked(() =>
{
    var data = Dev().DumpPage((byte)page);
    return Results.Ok(new { page, bytes = data.Length, hex = Convert.ToHexString(data) });
}))
    .WithTags("Debug").WithSummary("Raw 0x75 block-page dump (hex).");

app.MapGet("/debug/monitor", (long? since) =>
    Results.Ok(monLog.Where(e => e.Seq > (since ?? 0)).ToArray()))
    .WithTags("Debug").WithSummary("Live SysEx frame tap (TX+RX) since ?since=<seq>.");

app.MapGet("/debug/raw/{func:int}", (int func, string? body) => Locked(() =>
{
    byte[] b = string.IsNullOrEmpty(body) ? Array.Empty<byte>() : Convert.FromHexString(body);
    var frames = Dev().Exchange((byte)func, b);
    return Results.Ok(frames.Select(f => new { func = f.Func, len = f.Body.Length, hex = Convert.ToHexString(f.Body) }));
}))
    .WithTags("Debug").WithSummary("Send a raw SysEx function (+ optional hex body) and return every reply frame.");

app.Run();

// =====================================================================
//  DTOs (the public JSON contract)
// =====================================================================
record MonEntry(long Seq, string Ts, string Dir, byte Func, int Len, string Hex);
record FirmwareDto(string Version, string Build);
record DeviceInfo(string Model, string ModelByte, FirmwareDto? Firmware, string Port);
record ParamInfo(int Index, string Name, string Unit, double Min, double Max, string Scale,
                 string? Type, string? Role, string? Tier, string? Group, Dictionary<string, string>? Options);
record BlockSummary(string Slug, string Name, int Page, int ParamCount, int TypeCount);
record TypeOption(string Value, string Name);
record BlockDetail(string Slug, string Name, int Page, IEnumerable<ParamInfo> Params, IEnumerable<TypeOption> Types);
record PresetRef(int Number, string Name);
record GridCellDto(int Row, int Col, int EffectId, string Name, bool IsShunt, int RouteFlag, int[] FromRows);
record GridDto(string Model, string Name, bool CrcValid, int Rows, int Cols,
               IEnumerable<string> Scenes, IEnumerable<GridCellDto> Cells);
record PlacedBlock(string Slug, string Name, int EffectId, int Row, int Col, int[] FromRows,
                   bool? Bypassed, string? Channel);
record SelectRequest(int Number);
record SetValue(double Value);

public partial class Program { }
