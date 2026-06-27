using ForgeFX.Core;
using System.Text.Json;

// ForgeFX.Server — HTTP API over the FM3 SDK. Run this on the box the FM3 is plugged into
// (PC or Raspberry Pi); a web frontend talks to it. It owns the serial port, so it can't
// run alongside the fm3-midi-bridge / FM3-Edit.

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var devicePath = app.Configuration["device"] ?? "/dev/ttyACM0";
var defsDir = app.Configuration["definitions"] ?? "definitions";
var packs = Definitions.LoadDirectory(defsDir);
// block id -> display name (for the status dump), from fm3-blocks.json
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

Fm3Device Dev() { lock (gate) { if (device == null) { device = new Fm3Device(devicePath); device.FrameLog = LogFrame; } return device; } }
T Locked<T>(Func<T> f) { lock (gate) return f(); }

// background loop: drain the device's unsolicited push frames into the monitor
_ = Task.Run(async () =>
{
    while (true)
    {
        try { lock (gate) { Dev().DrainIncoming(); } } catch { /* device not ready */ }
        await Task.Delay(20);
    }
});

app.MapGet("/healthz", () => Results.Ok(new { ok = true, device = devicePath }));

app.MapGet("/firmware", () => Locked(() =>
    Dev().Firmware() is { } fw ? Results.Ok(fw) : Results.Problem("no reply from device")));

app.MapGet("/preset/current", () => Locked(() =>
{
    var p = Dev().QueryPreset();
    return Results.Ok(new { number = p.Number, name = p.Name });
}));

// Effects in the current preset (func 0x13): id, name, bypass, channel (A-D).
app.MapGet("/status", () => Locked(() =>
    Results.Ok(Dev().StatusDump().Select(s => new
    {
        id = s.Id,
        name = blockNames.TryGetValue(s.Id, out var nm) ? nm : $"Block {s.Id}",
        bypassed = s.Bypassed,
        channel = (char)('A' + s.Channel)
    }))));

// Live traffic monitor: all frames to/from the device since ?since=<seq> (TX + RX).
app.MapGet("/debug/monitor", (long? since) =>
    Results.Ok(monLog.Where(e => e.Seq > (since ?? 0)).ToArray()));

// Debug/RE: send a raw func (+ optional hex body) and return every reply frame's hex.
app.MapGet("/debug/raw/{func:int}", (int func, string? body) => Locked(() =>
{
    byte[] b = string.IsNullOrEmpty(body) ? Array.Empty<byte>() : Convert.FromHexString(body);
    var frames = Dev().Exchange((byte)func, b);
    return Results.Ok(frames.Select(f => new { func = f.Func, len = f.Body.Length, hex = Convert.ToHexString(f.Body) }));
}));

app.MapPost("/preset", (PresetRequest r) => Locked(() =>
{
    Dev().SelectPreset(r.N);
    return Results.Ok(new { ok = true, preset = r.N });
}));

app.MapPost("/param", (ParamRequest r) => Locked(() =>
{
    var stored = Dev().SetParam(r.Effect, r.Addr, r.Value);
    return Results.Ok(new { ok = true, stored });
}));

app.MapGet("/dump/{page:int}", (int page) => Locked(() =>
{
    var data = Dev().DumpPage((byte)page);
    return Results.Ok(new { page, bytes = data.Length, hex = Convert.ToHexString(data) });
}));

// ---- librarian: preset backup / restore ----

// GET /preset/{n}/backup  -> download the preset as a .syx file (n omitted/"current" = edit buffer)
app.MapGet("/preset/{n:int}/backup", (int n) => Locked(() =>
{
    var syx = Dev().DumpPreset(n);
    return syx.Length == 0 ? Results.Problem($"no data for preset {n}")
        : Results.Bytes(syx, "application/octet-stream", $"preset-{n}.syx");
}));

app.MapGet("/preset/current/backup", () => Locked(() =>
{
    var syx = Dev().DumpPreset(null);
    return syx.Length == 0 ? Results.Problem("no data from edit buffer")
        : Results.Bytes(syx, "application/octet-stream", "preset-current.syx");
}));

// POST /preset/restore  (body = raw .syx bytes) -> send to the device (edit buffer / slot per header)
app.MapPost("/preset/restore", async (HttpRequest req) =>
{
    using var ms = new MemoryStream();
    await req.Body.CopyToAsync(ms);
    var syx = ms.ToArray();
    return Locked(() => { Dev().SendPreset(syx); return Results.Ok(new { ok = true, bytes = syx.Length }); });
});

// ---- named parameters (definition packs) ----

app.MapGet("/blocks", () => Results.Ok(packs.Keys));

// GET /block/{name}/params -> dump the block and return named, unit-scaled values
app.MapGet("/block/{name}/params", (string name) => Locked(() =>
{
    if (!packs.TryGetValue(name, out var def)) return Results.NotFound(new { error = $"no pack for '{name}'" });
    var dump = Dev().DumpPage((byte)def.Page);
    return Results.Ok(new { block = def.Name, page = def.Page, named = Definitions.ReadNamed(def, dump) });
}));

app.Run();

// request DTOs (minimal-API model binding from JSON body)
record MonEntry(long Seq, string Ts, string Dir, byte Func, int Len, string Hex);
record PresetRequest(int N);
record ParamRequest(byte Effect, byte[] Addr, float Value);
