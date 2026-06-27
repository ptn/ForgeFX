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

    /// <summary>The serial path this instance opened.</summary>
    public string PortName => _port.PortName;

    /// <summary>Best-effort auto-detection of a connected Fractal serial port.
    /// On Linux, prefers the stable <c>/dev/serial/by-id/…Fractal…</c> symlink (the FM3
    /// exposes its control serial on USB interface <c>if03</c>) — that survives the device
    /// hopping between <c>ttyACM0</c>/<c>ttyACM1</c>. Falls back to a lone <c>ttyACM*</c>,
    /// then to the first system COM port. Returns null if nothing plausible is present.</summary>
    public static string? AutoDetectPort()
    {
        try
        {
            const string byId = "/dev/serial/by-id";
            if (Directory.Exists(byId))
            {
                var fractal = Directory.GetFileSystemEntries(byId)
                    .Where(l => Path.GetFileName(l).Contains("Fractal", StringComparison.OrdinalIgnoreCase))
                    .ToArray();
                var best = Array.Find(fractal, l => Path.GetFileName(l).Contains("if03", StringComparison.OrdinalIgnoreCase))
                           ?? (fractal.Length > 0 ? fractal[0] : null);
                if (best != null) return best;
            }
            if (Directory.Exists("/dev"))
            {
                var acm = Directory.GetFiles("/dev", "ttyACM*");
                if (acm.Length > 0) { Array.Sort(acm); return acm[0]; }
            }
        }
        catch { /* fall through to port-name scan */ }
        try { var n = SerialPort.GetPortNames(); if (n.Length > 0) return n[0]; } catch { }
        return null;
    }

    /// <summary>Optional tap for a live monitor: (isTx, func, body) per frame.</summary>
    public Action<bool, byte, byte[]>? FrameLog;

    public void Send(byte func, ReadOnlySpan<byte> body = default)
    {
        var f = FractalSysex.BuildFrame(func, body);
        FrameLog?.Invoke(true, func, body.ToArray());
        _port.Write(f, 0, f.Length);
    }

    private readonly List<byte> _monBuf = new();
    /// <summary>Read any buffered incoming bytes and emit complete frames via FrameLog (for the monitor).</summary>
    public void DrainIncoming()
    {
        int n = _port.BytesToRead;
        if (n > 0)
        {
            var tmp = new byte[n];
            int r = _port.Read(tmp, 0, n);
            for (int i = 0; i < r; i++) _monBuf.Add(tmp[i]);
        }
        while (true)
        {
            int s = _monBuf.IndexOf(0xF0);
            if (s < 0) { _monBuf.Clear(); break; }
            if (s > 0) _monBuf.RemoveRange(0, s);
            int e = _monBuf.IndexOf(0xF7);
            if (e < 0) break; // partial frame; wait for more
            var msg = _monBuf.GetRange(0, e + 1).ToArray();
            _monBuf.RemoveRange(0, e + 1);
            if (FractalSysex.ParseFrame(msg) is { } fr) FrameLog?.Invoke(false, fr.Func, fr.Body);
        }
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

    /// <summary>Query a preset's number + name (func 0x0D). n=null → the current preset.
    /// 0x0D is occasionally dropped (status stream / busy edit buffer), so retry once.</summary>
    public (int Number, string Name) QueryPreset(int? n = null)
    {
        int num = n ?? 0x3FFF; // 7F 7F = current
        byte[] body = { (byte)(num & 0x7F), (byte)((num >> 7) & 0x7F) };
        for (int attempt = 0; attempt < 2; attempt++)
        {
            if (Request(0x0D, body) is { } r && r.Body.Length >= 2)
            {
                int number = r.Body[0] | (r.Body[1] << 7);
                var name = Encoding.ASCII.GetString(r.Body, 2, r.Body.Length - 2).Split('\0')[0].TrimEnd();
                return (number, name);
            }
        }
        return (-1, "");
    }

    /// <summary>Status dump (func 0x13): the effects in the current preset, with bypass + channel.</summary>
    public List<(int Id, bool Bypassed, int Channel)> StatusDump(int timeoutMs = 1500)
    {
        var list = new List<(int, bool, int)>();
        if (Request(0x13, default, timeoutMs) is not { } r) return list;
        var b = r.Body;
        for (int i = 0; i + 2 < b.Length; i += 3)
        {
            int id = b[i] | (b[i + 1] << 7);
            byte flags = b[i + 2];
            list.Add((id, (flags & 0x01) != 0, (flags >> 1) & 0x07));
        }
        return list;
    }

    /// <summary>Debug/RE: send a raw func+body and collect every reply frame until timeout.</summary>
    public List<FractalSysex.Frame> Exchange(byte func, ReadOnlySpan<byte> body, int timeoutMs = 1500)
    {
        _port.DiscardInBuffer();
        Send(func, body);
        return ReadUntil(_ => false, timeoutMs).ToList();
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

    /// <summary>Back up a preset to a .syx byte stream (func 0x03 request →
    /// 0x77 + 0x78×8 + 0x79). preset = null reads the current edit buffer (0x7F7F).</summary>
    public byte[] DumpPreset(int? preset = null, int timeoutMs = 5000)
    {
        int n = preset ?? 0x3FFF;
        byte[] body = { (byte)((n >> 7) & 0x7F), (byte)(n & 0x7F), 0x00 };  // [hi, lo, 0]
        _port.DiscardInBuffer();
        Send(0x03, body);
        return ReadRawUntil(0x79, new byte[] { 0x77, 0x78, 0x79 }, timeoutMs);
    }

    /// <summary>Restore a preset by sending its .syx stream (0x77 + 0x78×8 + 0x79) as-is.
    /// The 0x77 header's id field selects the slot (0x7F7F = edit buffer).</summary>
    public void SendPreset(ReadOnlySpan<byte> syx) => _port.Write(syx.ToArray(), 0, syx.Length);

    // ====================================================================
    //  gen-3 write layer (FM3-confirmed frames)
    //
    //  A write is ACCEPTED unless the device answers with a 0x64
    //  MULTIPURPOSE_RESPONSE rejection [echoedFn, resultCode] for the
    //  function we sent — there is no echo on accept. Frame layouts are the
    //  gen-3 family ops (set param fn01 sub09/sub52, bypass fn0A, channel
    //  fn0B, grid insert sub32, grid routing sub35, switch sub27, store sub26),
    //  with the FM3 4-row routing formula. See docs/write-protocol.md.
    // ====================================================================

    /// <summary>Result of a write: accepted, or rejected with a device result code.</summary>
    public readonly record struct WriteResult(bool Accepted, int ResultCode, string? Error)
    {
        public static WriteResult Ok => new(true, -1, null);
    }

    /// <summary>14-bit value as two little-endian 7-bit bytes (septet pair).</summary>
    private static byte[] Enc14(int v) => new[] { (byte)(v & 0x7F), (byte)((v >> 7) & 0x7F) };

    /// <summary>Build a gen-3 write frame WITHOUT sending it (dry-run / tests).</summary>
    public static byte[] BuildFrame(byte func, ReadOnlySpan<byte> body) => FractalSysex.BuildFrame(func, body);

    /// <summary>Send a write frame and watch ~<paramref name="verifyMs"/> for a 0x64
    /// rejection of <paramref name="func"/>. No rejection in the window ⇒ accepted.</summary>
    public WriteResult SendWrite(byte func, ReadOnlySpan<byte> body, int verifyMs = 250)
    {
        bool IsReject(FractalSysex.Frame fr) =>
            fr.Func == 0x64 && fr.Body.Length is >= 2 and <= 4 && (fr.Body[0] & 0x7F) == func;
        _port.DiscardInBuffer();
        Send(func, body);
        foreach (var f in ReadUntil(IsReject, verifyMs))
            if (IsReject(f))
            {
                int code = f.Body[1] & 0x7F;
                return new WriteResult(false, code, DescribeResultCode(code));
            }
        return WriteResult.Ok;
    }

    // ---- pure body builders (no I/O — unit-testable) -------------------

    /// <summary>SET-parameter body (fn 0x01). continuous ⇒ sub 0x52 (knob; value normalized
    /// 0..1); typed ⇒ sub 0x09 (model/type select; value = roster ordinal). 5-septet float32.</summary>
    public static byte[] ParamBody(int effectId, int paramId, float value, bool continuous)
    {
        var body = new byte[15];
        body[0] = continuous ? (byte)0x52 : (byte)0x09;
        Enc14(effectId).CopyTo(body, 2);
        Enc14(paramId).CopyTo(body, 4);
        FractalSysex.PackFloat(value).CopyTo(body, 6); // float32 @ 6..10; 11..14 zero
        return body;
    }

    /// <summary>Bypass body (fn 0x0A): [eid14, dd].</summary>
    public static byte[] BypassBody(int effectId, bool bypassed) =>
        new[] { (byte)(effectId & 0x7F), (byte)((effectId >> 7) & 0x7F), (byte)(bypassed ? 1 : 0) };

    /// <summary>Channel body (fn 0x0B): [eid14, ch] (0..3 = A..D).</summary>
    public static byte[] ChannelBody(int effectId, int channel) =>
        new[] { (byte)(effectId & 0x7F), (byte)((effectId >> 7) & 0x7F), (byte)(channel & 0x7F) };

    /// <summary>5-septet little-endian raw uint32 (NOT float) — for value32 fields like gridPos.</summary>
    private static byte[] Sept5(int v)
    {
        var b = new byte[5];
        for (int i = 0; i < 5; i++) b[i] = (byte)((v >> (7 * i)) & 0x7F);
        return b;
    }

    /// <summary>Cell-select body (fn 0x01 sub 0x30): moves the edit cursor to a cell.
    /// gridPos rides as a 5-septet uint32 at the value32 field (pos 6). FM3 needs this
    /// sent BEFORE a sub 0x32 insert or the block lands at the default cell (live-confirmed).</summary>
    public static byte[] SelectCellBody(int row, int col, int rows = 4)
    {
        int gridPos = (col - 1) * rows + (row - 1);
        var body = new byte[15];
        body[0] = 0x30;
        Sept5(gridPos).CopyTo(body, 6); // value32 @ 6..10
        return body;
    }

    /// <summary>Grid-cell insert/clear body (fn 0x01 sub 0x32). gridPos=(col-1)*rows+(row-1).</summary>
    public static byte[] GridCellBody(int row, int col, int blockId, int rows = 4)
    {
        int gridPos = (col - 1) * rows + (row - 1);
        var body = new byte[15];
        body[0] = 0x32;
        Enc14(blockId).CopyTo(body, 2); // 2..3 ; 4..5 zero
        Enc14(gridPos).CopyTo(body, 6); // 6..7 ; 8..14 zero
        return body;
    }

    /// <summary>Grid-routing body (fn 0x01 sub 0x35), (srcRow,srcCol)→(destRow,srcCol+1).
    /// FM3 = 4-row formula (byte-confirmed); 6-row for III/FM9.</summary>
    public static byte[] GridRoutingBody(int srcRow, int srcCol, int destRow, bool connect, int rows = 4)
    {
        int op = connect ? 0x01 : 0x02;
        int srcGp = (srcCol - 1) * rows + (srcRow - 1);
        int b21 = srcGp >> 1, b22, b23;
        if (rows == 4)
        {
            b22 = ((srcGp & 1) << 6) | srcCol; // FM3: colTerm = srcCol, no destSign
            b23 = (destRow - 1) << 5;          // linear 1-indexed
        }
        else
        {
            int colTerm = (3 * (srcCol - 1)) / 2 + 1;
            int destSign = destRow >= 3 ? 1 : 0;
            b22 = ((srcGp & 1) << 6) | (colTerm + destSign);
            b23 = ((Math.Abs(destRow - 3) + (srcCol % 2 == 0 ? 2 : 0)) % 4) << 5;
        }
        return new byte[]
        {
            0x35, 0, 0, 0, 0, 0, (byte)op, 0, 0, 0, 0, 0, 0, 0x02, 0,
            (byte)b21, (byte)b22, (byte)b23,
        };
    }

    /// <summary>Switch-preset body (fn 0x01 sub 0x27): preset @ 6..7.</summary>
    public static byte[] SwitchPresetBody(int n)
    {
        var body = new byte[15];
        body[0] = 0x27;
        Enc14(n).CopyTo(body, 6);
        return body;
    }

    /// <summary>Store-preset body (fn 0x01 sub 0x26): preset @ 6..7.</summary>
    public static byte[] StoreBody(int n)
    {
        var body = new byte[15];
        body[0] = 0x26;
        Enc14(n).CopyTo(body, 6);
        return body;
    }

    // ---- write ops (build + send + verify) -----------------------------

    /// <summary>SET a parameter. continuous ⇒ knob (normalized 0..1); typed ⇒ model select (ordinal).</summary>
    public WriteResult SetParamValue(int effectId, int paramId, float value, bool continuous = true)
        => SendWrite(0x01, ParamBody(effectId, paramId, value, continuous));

    /// <summary>Engage/bypass a block (fn 0x0A).</summary>
    public WriteResult SetBypass(int effectId, bool bypassed) => SendWrite(0x0A, BypassBody(effectId, bypassed));

    /// <summary>Select a block channel (fn 0x0B). 0..3 = A..D.</summary>
    public WriteResult SetChannel(int effectId, int channel) => SendWrite(0x0B, ChannelBody(effectId, channel));

    /// <summary>Place a block in a cell, or clear it (blockId=0). 1-indexed row/col; FM3 rows=4.
    /// Sends the cell-select (sub 0x30) cursor move first, then the insert (sub 0x32) — the FM3
    /// ignores the insert's position without a prior select (live-confirmed 2026-06-27).</summary>
    public WriteResult SetGridCell(int row, int col, int blockId, int rows = 4)
    {
        Send(0x01, SelectCellBody(row, col, rows)); // cursor select (no state change / no reply)
        Thread.Sleep(15);
        return SendWrite(0x01, GridCellBody(row, col, blockId, rows));
    }

    /// <summary>Cable (srcRow,srcCol)→(destRow,srcCol+1). FM3 rows=4. 1-indexed.</summary>
    public WriteResult SetGridRouting(int srcRow, int srcCol, int destRow, bool connect, int rows = 4)
        => SendWrite(0x01, GridRoutingBody(srcRow, srcCol, destRow, connect, rows));

    /// <summary>Switch the active preset via SysEx (fn 0x01 sub 0x27) — FM3-confirmed.</summary>
    public WriteResult SwitchPresetSysEx(int n) => SendWrite(0x01, SwitchPresetBody(n), 400);

    /// <summary>Persist the working buffer to a slot (fn 0x01 sub 0x26).
    /// ⚠ persistence is NOT hardware-verified on FM3 — confirm on the device.</summary>
    public WriteResult StorePreset(int n) => SendWrite(0x01, StoreBody(n), 600);

    /// <summary>Human label for a 0x64 result code (AxeEdit MIDI_ERROR_* table, 0x00..0x1b).</summary>
    public static string? DescribeResultCode(int code) => (code & 0x7F) switch
    {
        0x00 => "bad checksum",
        0x01 => "wrong SysEx manufacturer ID",
        0x02 => "wrong model number",
        0x03 => "bad argument",
        0x04 => "message not recognized",
        0x05 => "invalid effect ID",
        0x06 => "invalid parameter ID",
        0x07 => "effect not in use in this preset",
        0x08 => "no modifier slots left",
        0x09 => "wrong count",
        0x0a => "effect not routable here",
        0x0b => "bad grid position",
        0x0c => "DSP overload",
        0x0d => "function failed",
        0x0e => "invalid patch number",
        0x0f => "illegal message",
        0x10 => "bad message length",
        0x11 => "image size incorrect",
        0x12 => "bad image checksum",
        0x13 => "not ready for firmware update",
        0x14 => "buffer overrun",
        0x15 => "invalid cab number",
        0x16 => "invalid modifier ID",
        0x17 => "invalid bank number",
        0x18 => "firmware already current",
        0x19 => "command not supported",
        0x1a => "null data",
        0x1b => "flash write failed",
        _ => null,
    };

    // ---- framing read loop ----

    /// Collect raw SysEx frames whose func is in <paramref name="keep"/>, until one with
    /// func == stopFunc is seen. Returns the concatenated raw bytes (a .syx stream).
    private byte[] ReadRawUntil(byte stopFunc, byte[] keep, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        var buf = new List<byte>();
        var outBytes = new List<byte>();
        var tmp = new byte[8192];
        bool done = false;
        while (sw.ElapsedMilliseconds < timeoutMs && !done)
        {
            int nb = 0;
            try { if (_port.BytesToRead > 0) nb = _port.Read(tmp, 0, Math.Min(tmp.Length, _port.BytesToRead)); }
            catch (TimeoutException) { }
            if (nb > 0) buf.AddRange(tmp.AsSpan(0, nb).ToArray()); else Thread.Sleep(5);

            int consumed = 0;
            while (true)
            {
                int s = buf.IndexOf(FractalSysex.SysexStart, consumed);
                if (s < 0) break;
                int e = buf.IndexOf(FractalSysex.SysexEnd, s);
                if (e < 0) break;
                byte func = (e - s) >= 5 ? buf[s + 5] : (byte)0;
                if (Array.IndexOf(keep, func) >= 0) outBytes.AddRange(buf.GetRange(s, e - s + 1));
                if (func == stopFunc) done = true;
                consumed = e + 1;
            }
            if (consumed > 0) buf.RemoveRange(0, consumed);
        }
        return outBytes.ToArray();
    }

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
