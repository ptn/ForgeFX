using System.Text;

namespace ForgeFX.Core;

/// <summary>
/// Decodes a gen-3 Fractal preset dump (Axe-Fx III / FM3 / FM9, model 0x10/0x11/0x12)
/// into the routing grid + placed blocks — the data needed to render a live signal grid.
///
/// Pipeline (all offline, no extra device round-trips):
///   1. Walk the 0x77 / 0x78×N / 0x79 SysEx dump → N chunk payloads.
///   2. Reassemble: each chunk = 2-byte discriminator + 1024 ushorts packed
///      3 wire bytes/ushort (v = b0 | b1&lt;&lt;7 | b2&lt;&lt;14) → a 16384-byte raw_patch
///      (word0 = 0x0143 version, word1 = 0xAA55 magic, name at 0x08).
///   3. raw_patch: CRC16/CCITT @0x04, decompSize u16 @0x48, compSize u16 @0x4A,
///      dynamic-Huffman bitstream @0x4C.
///   4. Huffman-decompress the body, then read the grid at body offset 0x104:
///      column-major, 2 words/cell (effect_id + route-flag bitmask), FM3 = 4×12.
///
/// The wire/format knowledge is reimplemented from the Apache-2.0 reference codec in
/// TheAndrewStaker/mcp-midi-control (packages/fractal-gen3/src/preset{Dump,Huffman,Body}.ts),
/// which itself credits Andrew Mercurio / BoodieTraps' Apache-2.0 `fractal-syx-codec`
/// (FORMAT.md). Attribution retained per Apache-2.0; see ForgeFX NOTICE.
/// </summary>
public static class Fm3PresetCodec
{
    public const byte ModelAxeFxIII = 0x10;
    public const byte ModelFm3 = 0x11;
    public const byte ModelFm9 = 0x12;

    // raw_patch field offsets
    private const int CrcOffset = 0x04;
    private const int DecompSizeOffset = 0x48;
    private const int CompSizeOffset = 0x4A;
    private const int BodyOffset = 0x4C;
    private const ushort CrcInit = 0xAA55;

    // decompressed-body offsets
    private const int GridBase = 0x104;
    private const int SceneNameBase = 0x04;

    public sealed record GridCell(
        int EffectId, int Row, int Col, int RouteFlag,
        string Name, bool IsShunt, int[] FromRows);

    public sealed record DecodedPreset(
        int ModelId, string ModelName, string Name, bool CrcValid,
        int Rows, int Cols, IReadOnlyList<GridCell> Grid,
        IReadOnlyList<string> SceneNames);

    /// <summary>Decode a full preset .syx dump (device or file) into grid + metadata.</summary>
    public static DecodedPreset Decode(ReadOnlySpan<byte> dump, byte? expectedModel = null)
    {
        var (modelId, chunks) = ParseDump(dump, expectedModel);
        var rawPatch = Reassemble(chunks);

        ushort storedCrc = U16(rawPatch, CrcOffset);
        ushort computedCrc = ComputeCrc(rawPatch);
        int decompSize = U16(rawPatch, DecompSizeOffset);
        int compSize = U16(rawPatch, CompSizeOffset);

        var compData = rawPatch.AsSpan(BodyOffset, Math.Min(compSize, rawPatch.Length - BodyOffset));
        var body = HuffmanUncompress(compData, decompSize);

        var (rows, cols) = GridDims(modelId);
        var grid = body.Length >= 0x1C4 ? ParseGrid(body, rows, cols) : new List<GridCell>();
        var scenes = ReadSceneNames(body);
        string name = AsciiName(rawPatch, 0x08, 32);

        return new DecodedPreset(modelId, ModelName(modelId), name,
            storedCrc == computedCrc, rows, cols, grid, scenes);
    }

    // ---- 1. dump framing → chunk payloads ----

    private static (byte modelId, List<byte[]> chunks) ParseDump(ReadOnlySpan<byte> bytes, byte? expectedModel)
    {
        var chunks = new List<byte[]>();
        byte modelId = expectedModel ?? 0;
        int i = 0;
        while (i < bytes.Length)
        {
            int start = bytes[i..].IndexOf(FractalSysex.SysexStart);
            if (start < 0) break;
            start += i;
            int end = bytes[start..].IndexOf(FractalSysex.SysexEnd);
            if (end < 0) break;
            end += start;
            var frame = bytes[start..(end + 1)];
            // F0 00 01 74 <model> <func> <payload...> <cksum> F7
            if (frame.Length >= 8 && frame[1] == 0x00 && frame[2] == 0x01 && frame[3] == 0x74)
            {
                byte model = frame[4];
                byte func = frame[5];
                if (modelId == 0) modelId = model;
                if (func == 0x78)
                    chunks.Add(frame[6..^2].ToArray()); // payload between func and checksum
            }
            i = end + 1;
        }
        if (chunks.Count == 0)
            throw new InvalidDataException("no 0x78 preset chunks found in dump");
        return (modelId, chunks);
    }

    // ---- 2. reassemble 3-byte-septet chunk image → raw_patch ----

    private static byte[] Reassemble(List<byte[]> chunks)
    {
        // each chunk: [2-byte discriminator][1024 ushorts × 3 bytes]
        var words = new List<ushort>(chunks.Count * 1024);
        foreach (var c in chunks)
        {
            int n = (c.Length - 2) / 3;
            for (int k = 0; k < n; k++)
            {
                int o = 2 + k * 3;
                words.Add((ushort)((c[o] | (c[o + 1] << 7) | (c[o + 2] << 14)) & 0xFFFF));
            }
        }
        var img = new byte[words.Count * 2];
        for (int k = 0; k < words.Count; k++)
        {
            img[k * 2] = (byte)(words[k] & 0xFF);
            img[k * 2 + 1] = (byte)((words[k] >> 8) & 0xFF);
        }
        return img;
    }

    // ---- 3. dynamic-Huffman decompression ----

    private sealed class HuffNode
    {
        public int Value = -1;       // >=0 leaf symbol, -1 internal
        public HuffNode? Left, Right;
    }

    private sealed class BitReader(ReadOnlySpan<byte> data)
    {
        private readonly byte[] _data = data.ToArray();
        private int _pos, _bit;
        public bool Exhausted => _pos >= _data.Length;
        public int ReadBit()
        {
            byte b = _pos < _data.Length ? _data[_pos] : (byte)0;
            int outBit = (b >> (7 - _bit)) & 1;
            if (++_bit == 8) { _bit = 0; _pos++; }
            return outBit;
        }
        public int ReadByteValue()
        {
            int v = 0;
            for (int i = 0; i < 8; i++) v = (v << 1) | ReadBit();
            return v;
        }
    }

    private static HuffNode BuildTree(BitReader r)
    {
        if (r.ReadBit() == 1) return new HuffNode { Value = r.ReadByteValue() };
        var left = BuildTree(r);
        var right = BuildTree(r);
        return new HuffNode { Value = -1, Left = left, Right = right };
    }

    private static byte[] HuffmanUncompress(ReadOnlySpan<byte> data, int outputSize)
    {
        if (data.Length == 0 || outputSize <= 0) return Array.Empty<byte>();
        var r = new BitReader(data);
        var root = BuildTree(r);
        var outBuf = new byte[outputSize];
        int i = 0;
        for (; i < outputSize && !r.Exhausted; i++)
        {
            var node = root;
            while (node.Value < 0)
                node = (r.ReadBit() == 1 ? node.Right : node.Left)!;
            outBuf[i] = (byte)(node.Value & 0xFF);
        }
        return i == outputSize ? outBuf : outBuf[..i];
    }

    // ---- 4. grid parse (column-major, 2 words/cell) ----

    private static List<GridCell> ParseGrid(byte[] body, int rows, int cols)
    {
        int wordsPerCol = rows * 2;
        var cells = new List<GridCell>();
        for (int col = 0; col < cols; col++)
        {
            for (int row = 0; row < rows; row++)
            {
                int idx = col * wordsPerCol + row * 2;
                int eid = U16(body, GridBase + idx * 2);
                int flag = U16(body, GridBase + (idx + 1) * 2);
                if (eid == 0) continue;

                bool shunt = eid > 1000;
                string name = shunt ? $"Shunt {eid - 1023}" : (EffectName(eid) ?? $"eid_{eid}");
                var fromRows = new List<int>();
                for (int r = 0; r < rows; r++)
                    if ((flag & (1 << r)) != 0) fromRows.Add(r);

                cells.Add(new GridCell(eid, row, col, flag, name, shunt, fromRows.ToArray()));
            }
        }
        return cells;
    }

    // grid effect-id → family base; instances 1..4 are base..base+3
    private static readonly Dictionary<int, string> EffectBases = new()
    {
        [37] = "Input", [42] = "Output", [46] = "Comp", [50] = "GEQ", [54] = "PEQ",
        [58] = "Amp", [62] = "Cab", [66] = "Reverb", [70] = "Delay", [74] = "MultiTap",
        [78] = "Chorus", [82] = "Flanger", [86] = "Rotary", [90] = "Phaser", [94] = "Wah",
        [98] = "Formant", [102] = "Vol/Pan", [106] = "Tremolo", [110] = "Pitch",
        [114] = "Filter", [118] = "Drive", [122] = "Enhancer", [126] = "Mixer",
        [130] = "Synth", [138] = "Megatap", [146] = "Gate", [150] = "RingMod",
        [154] = "MultiComp", [158] = "Ten-Tap", [162] = "Resonator", [166] = "Looper",
        [178] = "Plex Delay", [182] = "Send", [186] = "Return", [191] = "Multiplexer",
    };

    /// <summary>Resolve an effect id to "Family N" (e.g. 58→"Amp 1", 119→"Drive 2").</summary>
    public static string? EffectName(int eid)
    {
        if (EffectBases.TryGetValue(eid, out var exact)) return $"{exact} 1";
        foreach (var (baseId, name) in EffectBases)
        {
            int d = eid - baseId;
            if (d > 0 && d <= 3) return $"{name} {d + 1}";
        }
        return null;
    }

    // ---- helpers ----

    private static (int rows, int cols) GridDims(int modelId) => modelId switch
    {
        ModelFm3 => (4, 12),
        ModelFm9 => (6, 14),
        ModelAxeFxIII => (6, 14),
        _ => (4, 12),
    };

    private static string ModelName(int modelId) => modelId switch
    {
        ModelAxeFxIII => "Axe-Fx III",
        ModelFm3 => "FM3",
        ModelFm9 => "FM9",
        _ => $"model_0x{modelId:x2}",
    };

    private static List<string> ReadSceneNames(byte[] body)
    {
        var scenes = new List<string>();
        if (body.Length >= 0x104)
            for (int i = 0; i < 8; i++)
                scenes.Add(AsciiName(body, SceneNameBase + i * 32, 32));
        return scenes;
    }

    private static ushort U16(byte[] b, int off) =>
        off + 1 < b.Length ? (ushort)((b[off] | (b[off + 1] << 8)) & 0xFFFF) : (ushort)0;

    private static string AsciiName(byte[] data, int start, int len)
    {
        var sb = new StringBuilder();
        for (int i = 0; i < len && start + i < data.Length; i++)
        {
            byte b = data[start + i];
            if (b == 0) break;
            sb.Append((char)b);
        }
        return sb.ToString().Trim();
    }

    // CRC-16/CCITT (poly 0x1021, MSB-first), CRC field treated as zero.
    private static ushort ComputeCrc(byte[] rawPatch)
    {
        var tmp = (byte[])rawPatch.Clone();
        tmp[CrcOffset] = 0; tmp[CrcOffset + 1] = 0;
        ushort crc = CrcInit;
        foreach (var bb in tmp)
        {
            crc ^= (ushort)(bb << 8);
            for (int i = 0; i < 8; i++)
                crc = (ushort)(((crc & 0x8000) != 0) ? ((crc << 1) ^ 0x1021) : (crc << 1));
        }
        return crc;
    }
}
