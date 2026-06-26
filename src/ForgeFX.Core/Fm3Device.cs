using System.Diagnostics;
using System.IO.Ports;
using System.Text;

namespace ForgeFX.Core;

public readonly record struct FirmwareInfo(string Version, string Build);

/// <summary>
/// Talks to a Fractal FM3 over its USB serial port (CDC: /dev/ttyACM0 on Linux,
/// a COM port via Fractal's driver on Windows). Wraps the proven primitives:
/// firmware read, parameter write, preset select, and bulk block dump.
/// </summary>
public sealed class Fm3Device : IDisposable
{
    private const byte StatusFunc = 0x64; // continuous tuner/tempo stream — skip
    private readonly SerialPort _port;

    public Fm3Device(string portName = "/dev/ttyACM0")
    {
        _port = new SerialPort(portName, 115200) { ReadTimeout = 200, WriteTimeout = 500 };
        _port.Open();
        _port.DiscardInBuffer();
    }

    public void Dispose() => _port.Dispose();

    public void Send(byte func, ReadOnlySpan<byte> body = default)
    {
        var f = FractalSysex.BuildFrame(func, body);
        _port.Write(f, 0, f.Length);
    }

    /// <summary>Send a command and return the first reply that isn't the status stream.</summary>
    public FractalSysex.Frame? Request(byte func, ReadOnlySpan<byte> body = default, int timeoutMs = 1500)
    {
        _port.DiscardInBuffer();
        Send(func, body);
        foreach (var f in ReadUntil(f => f.Func != StatusFunc, timeoutMs))
            if (f.Func != StatusFunc) return f;
        return null;
    }

    public FirmwareInfo? Firmware()
    {
        if (Request(0x08) is not { } r) return null;
        var b = r.Body;
        var date = Encoding.ASCII.GetString(b, 4, Math.Max(0, Math.Min(20, b.Length - 4))).Split('\0')[0];
        return new FirmwareInfo($"{b[0]}.{b[1]}", date);
    }

    /// <summary>Write a parameter. addr = 5-byte param address. Returns the device's stored value.</summary>
    public float? SetParam(byte effect, ReadOnlySpan<byte> addr5, float value)
    {
        var body = new byte[1 + 5 + 5 + 4];
        body[0] = effect;
        addr5[..5].CopyTo(body.AsSpan(1));
        FractalSysex.PackFloat(value).CopyTo(body.AsSpan(6));
        if (Request(0x01, body) is { } r && r.Body.Length >= 11)
            return FractalSysex.UnpackFloat(r.Body.AsSpan(6, 5));
        return null;
    }

    /// <summary>Switch preset via Bank Select (CC#0) + Program Change (4 banks x 128).</summary>
    public void SelectPreset(int n)
    {
        byte[] msg = { 0xB0, 0x00, (byte)(n / 128), 0xC0, (byte)(n % 128) };
        _port.Write(msg, 0, msg.Length);
    }

    /// <summary>Bulk-read a block page (func 0x1f) → concatenated 0x75 payload (block state).
    /// Pages are per-block (this preset: Amp=0x3a, Cab=0x3e, Filter=0x72).
    /// Decode values with FractalSysex.UnpackDumpValue.</summary>
    public byte[] DumpPage(byte page, int timeoutMs = 1500)
    {
        _port.DiscardInBuffer();
        Send(0x1f, new byte[] { page, 0x00 });
        var frames = ReadUntil(f => f.Func == 0x76, timeoutMs);
        return frames.Where(f => f.Func == 0x75).SelectMany(f => f.Body).ToArray();
    }

    // ---- framing read loop ----

    private List<FractalSysex.Frame> ReadUntil(Func<FractalSysex.Frame, bool> stop, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        var buf = new List<byte>();
        var tmp = new byte[8192];
        var collected = new List<FractalSysex.Frame>();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            int n = 0;
            try { if (_port.BytesToRead > 0) n = _port.Read(tmp, 0, Math.Min(tmp.Length, _port.BytesToRead)); }
            catch (TimeoutException) { }
            if (n > 0) buf.AddRange(tmp.AsSpan(0, n).ToArray());
            else Thread.Sleep(5);

            var frames = Drain(buf);
            collected.AddRange(frames);
            if (frames.Any(stop)) break;
        }
        return collected;
    }

    private static List<FractalSysex.Frame> Drain(List<byte> buf)
    {
        var frames = new List<FractalSysex.Frame>();
        int consumed = 0;
        while (true)
        {
            int s = buf.IndexOf(FractalSysex.SysexStart, consumed);
            if (s < 0) break;
            int e = buf.IndexOf(FractalSysex.SysexEnd, s);
            if (e < 0) break;
            if (FractalSysex.ParseFrame(buf.GetRange(s, e - s + 1).ToArray()) is { } f)
                frames.Add(f);
            consumed = e + 1;
        }
        if (consumed > 0) buf.RemoveRange(0, consumed);
        return frames;
    }
}
