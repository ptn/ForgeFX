using ForgeFX.Core;

// ForgeFX.Server — HTTP API over the FM3 SDK. Run this on the box the FM3 is plugged into
// (PC or Raspberry Pi); a web frontend talks to it. It owns the serial port, so it can't
// run alongside the fm3-midi-bridge / FM3-Edit.

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var devicePath = app.Configuration["device"] ?? "/dev/ttyACM0";
var packs = Definitions.LoadDirectory(app.Configuration["definitions"] ?? "definitions");
var gate = new object();
Fm3Device? device = null;
Fm3Device Dev() { lock (gate) { return device ??= new Fm3Device(devicePath); } }
T Locked<T>(Func<T> f) { lock (gate) return f(); }

app.MapGet("/healthz", () => Results.Ok(new { ok = true, device = devicePath }));

app.MapGet("/firmware", () => Locked(() =>
    Dev().Firmware() is { } fw ? Results.Ok(fw) : Results.Problem("no reply from device")));

app.MapGet("/preset/current", () => Locked(() =>
{
    var p = Dev().QueryPreset();
    return Results.Ok(new { number = p.Number, name = p.Name });
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
record PresetRequest(int N);
record ParamRequest(byte Effect, byte[] Addr, float Value);
