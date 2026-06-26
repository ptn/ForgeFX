using ForgeFX.Core;

namespace ForgeFX.Core.Tests;

/// <summary>
/// Vectors captured from a real FM3 (firmware 12.0) via the fm3-protocol RE work.
/// These lock the C# port to the validated wire behaviour.
/// </summary>
public class FractalSysexTests
{
    private static byte[] Hex(string s) => Convert.FromHexString(s);

    [Fact]
    public void FirmwareQuery_FrameMatchesDevice()
    {
        // func 0x08, empty body -> the exact bytes the device answered to
        Assert.Equal("f000017411081cf7", Convert.ToHexString(FractalSysex.BuildFrame(0x08)).ToLowerInvariant());
    }

    [Fact]
    public void ParseFrame_RoundTrips()
    {
        var f = FractalSysex.ParseFrame(FractalSysex.BuildFrame(0x08));
        Assert.NotNull(f);
        Assert.Equal(FractalSysex.ModelFm3, f!.Value.Model);
        Assert.Equal(0x08, f.Value.Func);
        Assert.Empty(f.Value.Body);
    }

    [Fact]
    public void ParseFrame_RejectsBadChecksum()
    {
        var bytes = FractalSysex.BuildFrame(0x08);
        bytes[^2] ^= 0x01; // corrupt checksum
        Assert.Null(FractalSysex.ParseFrame(bytes));
    }

    [Theory]
    [InlineData(3740.5f, "0010272b04")] // filter freq, captured
    [InlineData(55.2f, "4d19731204")]   // cab low-cut Hz, captured
    public void PackFloat_MatchesCapturedWireBytes(float value, string hex)
    {
        Assert.Equal(hex, Convert.ToHexString(FractalSysex.PackFloat(value)).ToLowerInvariant());
        Assert.Equal(value, FractalSysex.UnpackFloat(Hex(hex)), 3);
    }

    [Fact]
    public void DumpValue_DecodesCapturedLowCut()
    {
        // Cab dump offset 188 = 6e 65 02 -> ~0.699 (= 100 Hz low-cut we wrote)
        float n = FractalSysex.UnpackDumpValue(Hex("6e6502"));
        Assert.Equal(0.699f, n, 3);
    }

    [Fact]
    public void DumpValue_RoundTrips()
    {
        var packed = FractalSysex.PackDumpValue(0.699f);
        Assert.Equal(0.699f, FractalSysex.UnpackDumpValue(packed), 3);
    }
}
