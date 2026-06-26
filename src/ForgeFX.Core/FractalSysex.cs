namespace ForgeFX.Core;

/// <summary>
/// Fractal MIDI-SysEx framing, checksum, and value codecs for the FM3.
///
/// Frame:  F0 00 01 74 &lt;model&gt; &lt;func&gt; &lt;body...&gt; &lt;checksum&gt; F7
///   manufacturer = 00 01 74, FM3 model = 0x11,
///   checksum = XOR of all bytes from F0 up to (excluding) the checksum, &amp; 0x7F.
///
/// Two value encodings (both little-endian, 7 data bits per byte):
///   * live get/set (func 0x01): IEEE-754 float32 across 5 bytes (engineering units or 0..1)
///   * bulk dump (func 0x75):    16-bit int across 3 bytes, normalized 0..1 by /65536
///
/// Ported from the validated Python reference (sKuhLight/fm3-protocol) and unit-tested
/// against captured device vectors.
/// </summary>
public static class FractalSysex
{
    public const byte SysexStart = 0xF0;
    public const byte SysexEnd = 0xF7;
    public const byte ModelFm3 = 0x11;
    public static ReadOnlySpan<byte> Manufacturer => new byte[] { 0x00, 0x01, 0x74 };

    public static byte Checksum(ReadOnlySpan<byte> data)
    {
        byte c = 0;
        foreach (var b in data) c ^= b;
        return (byte)(c & 0x7F);
    }

    public static byte[] BuildFrame(byte func, ReadOnlySpan<byte> body = default, byte model = ModelFm3)
    {
        var frame = new byte[6 + body.Length + 2];
        frame[0] = SysexStart;
        frame[1] = 0x00; frame[2] = 0x01; frame[3] = 0x74;
        frame[4] = model; frame[5] = func;
        body.CopyTo(frame.AsSpan(6));
        frame[^2] = Checksum(frame.AsSpan(0, frame.Length - 2));
        frame[^1] = SysexEnd;
        return frame;
    }

    public readonly record struct Frame(byte Model, byte Func, byte[] Body);

    public static Frame? ParseFrame(ReadOnlySpan<byte> msg)
    {
        if (msg.Length < 8 || msg[0] != SysexStart || msg[^1] != SysexEnd) return null;
        if (msg[1] != 0x00 || msg[2] != 0x01 || msg[3] != 0x74) return null;
        if (Checksum(msg[..^2]) != msg[^2]) return null;
        return new Frame(msg[4], msg[5], msg[6..^2].ToArray());
    }

    // ---- live value codec: float32, 5 x 7-bit LE ----

    public static byte[] PackFloat(float value)
    {
        uint v = BitConverter.SingleToUInt32Bits(value);
        var b = new byte[5];
        for (int i = 0; i < 5; i++) b[i] = (byte)((v >> (7 * i)) & 0x7F);
        return b;
    }

    public static float UnpackFloat(ReadOnlySpan<byte> b5)
    {
        uint v = 0;
        for (int i = 0; i < 5; i++) v |= (uint)(b5[i] & 0x7F) << (7 * i);
        return BitConverter.UInt32BitsToSingle(v);
    }

    // ---- dump value codec: 16-bit normalized, 3 x 7-bit LE ----

    public static float UnpackDumpValue(ReadOnlySpan<byte> b3)
    {
        int v = (b3[0] & 0x7F) | ((b3[1] & 0x7F) << 7) | ((b3[2] & 0x7F) << 14);
        return v / 65536f;
    }

    public static byte[] PackDumpValue(float norm)
    {
        int v = Math.Clamp((int)MathF.Round(norm * 65536f), 0, 0xFFFF);
        var b = new byte[3];
        for (int i = 0; i < 3; i++) b[i] = (byte)((v >> (7 * i)) & 0x7F);
        return b;
    }
}
