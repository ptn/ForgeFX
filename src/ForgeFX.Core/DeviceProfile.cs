namespace ForgeFX.Core;

/// <summary>
/// Per-device specifics for a Fractal unit. ForgeFX is not FM3-only — FM3 is the
/// current dev target; the gen-3 family (Axe-Fx III / FM3 / FM9) shares one codec
/// and differs only in these fields, so a sibling is added as a profile, not new code.
/// (AM4 and Axe-Fx II are separate families — different preset/write codecs — and
/// will get their own profiles + codecs later.)
/// </summary>
public sealed record DeviceProfile(
    string Id,
    string Name,
    byte ModelByte,
    int GridRows,
    int GridCols,
    int Channels,
    int Scenes);

/// <summary>Registry of supported Fractal devices. gen-3 family today; extend as devices land.</summary>
public static class FractalDevices
{
    public static readonly DeviceProfile Fm3      = new("fm3",    "FM3",         0x11, 4, 12, 4, 8);
    public static readonly DeviceProfile Fm9      = new("fm9",    "FM9",         0x12, 6, 14, 4, 8);
    public static readonly DeviceProfile AxeFxIII = new("axefx3", "Axe-Fx III",  0x10, 6, 14, 4, 8);

    /// <summary>All known gen-3 profiles.</summary>
    public static readonly IReadOnlyList<DeviceProfile> All = new[] { Fm3, Fm9, AxeFxIII };

    /// <summary>Profile for a SysEx model byte (defaults to FM3 if unknown).</summary>
    public static DeviceProfile ByModel(int modelByte) =>
        All.FirstOrDefault(p => p.ModelByte == (byte)modelByte) ?? Fm3;

    /// <summary>Profile for a config id like "fm3"/"fm9"/"axefx3" (defaults to FM3).</summary>
    public static DeviceProfile Resolve(string? id) =>
        id is null ? Fm3 : All.FirstOrDefault(p => p.Id.Equals(id, StringComparison.OrdinalIgnoreCase)) ?? Fm3;
}
