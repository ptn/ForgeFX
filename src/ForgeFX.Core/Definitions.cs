using System.Text.Json;
using System.Text.Json.Serialization;

namespace ForgeFX.Core;

public enum Scale { Linear, Log, Raw }

/// <summary>One parameter's definition: its dump index, human name, and how the wire
/// value (normalized 0..1, or raw for Scale.Raw) maps to engineering units.</summary>
public record ParamDef(int Index, string Name, string Unit = "", double Min = 0, double Max = 1,
                       Scale Scale = Scale.Linear);

/// <summary>A block's parameter map: name, dump page id, and its parameters.
/// Authored from docs and verified against the device (correlate.py).</summary>
public record BlockDef(string Name, int Page, ParamDef[] Params);

public sealed record NamedValue(string Name, double Value, string Unit, double Norm);

public static class Definitions
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() }
    };

    public static double ToEngineering(ParamDef p, double norm) => p.Scale switch
    {
        Scale.Log => p.Min * Math.Pow(p.Max / p.Min, norm),
        Scale.Raw => norm * 65536.0,                       // un-normalized integer/index
        _ => p.Min + norm * (p.Max - p.Min),               // linear
    };

    /// <summary>Decode a block dump (0x75 payload) into the normalized value array
    /// (3-byte values after a short header).</summary>
    public static double[] DumpValues(ReadOnlySpan<byte> dump, int baseOffset = 2)
    {
        int n = Math.Max(0, (dump.Length - baseOffset) / 3);
        var v = new double[n];
        for (int i = 0; i < n; i++)
            v[i] = FractalSysex.UnpackDumpValue(dump.Slice(baseOffset + 3 * i, 3));
        return v;
    }

    /// <summary>Apply a block definition to a dump → named, unit-scaled values.</summary>
    public static List<NamedValue> ReadNamed(BlockDef block, byte[] dump, int baseOffset = 2)
    {
        var vals = DumpValues(dump, baseOffset);
        var outv = new List<NamedValue>();
        foreach (var p in block.Params)
            if (p.Index < vals.Length)
                outv.Add(new NamedValue(p.Name, Math.Round(ToEngineering(p, vals[p.Index]), 3),
                                        p.Unit, Math.Round(vals[p.Index], 4)));
        return outv;
    }

    public static BlockDef Load(string jsonPath) =>
        JsonSerializer.Deserialize<BlockDef>(File.ReadAllText(jsonPath), JsonOpts)
        ?? throw new InvalidDataException($"bad definition pack: {jsonPath}");

    /// <summary>Load all *.json packs from a directory, keyed by block name (lowercased).</summary>
    public static Dictionary<string, BlockDef> LoadDirectory(string dir)
    {
        var packs = new Dictionary<string, BlockDef>(StringComparer.OrdinalIgnoreCase);
        if (!Directory.Exists(dir)) return packs;
        foreach (var f in Directory.EnumerateFiles(dir, "*.json"))
        {
            try { var b = Load(f); packs[b.Name] = b; } catch { /* skip bad pack */ }
        }
        return packs;
    }
}
