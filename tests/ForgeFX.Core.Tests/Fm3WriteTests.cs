using ForgeFX.Core;

namespace ForgeFX.Core.Tests;

/// <summary>
/// Pins the gen-3 write-frame construction to the documented byte layouts
/// (set param fn01 sub09/sub52, bypass fn0A, channel fn0B, grid insert sub32,
/// grid routing sub35 FM3 4-row, switch sub27, store sub26). Pure builders —
/// no device. Wire shapes from the mcp-midi-control gen-3 codec (FM3-confirmed).
/// </summary>
public class Fm3WriteTests
{
    private static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

    [Fact]
    public void ParamBody_Continuous_IsSub52_WithEidPidFloat()
    {
        var body = Fm3Device.ParamBody(effectId: 58, paramId: 1, value: 0.5f, continuous: true);
        Assert.Equal(15, body.Length);
        Assert.Equal(0x52, body[0]);                 // continuous sub-action
        Assert.Equal(new byte[] { 58, 0 }, body[2..4]);   // eid 14-bit LE
        Assert.Equal(new byte[] { 1, 0 }, body[4..6]);    // pid 14-bit LE
        Assert.Equal(FractalSysex.PackFloat(0.5f), body[6..11]); // float32 @ 6..10
        Assert.Equal(new byte[] { 0, 0, 0, 0 }, body[11..15]);   // trailing pad
    }

    [Fact]
    public void ParamBody_Typed_IsSub09_OrdinalRoundTrips()
    {
        var body = Fm3Device.ParamBody(effectId: 118, paramId: 0, value: 16f, continuous: false);
        Assert.Equal(0x09, body[0]);                 // typed/select sub-action
        Assert.Equal(16f, FractalSysex.UnpackFloat(body[6..11])); // ordinal as float32
    }

    [Fact]
    public void Bypass_And_Channel_Bodies()
    {
        Assert.Equal(new byte[] { 58, 0, 1 }, Fm3Device.BypassBody(58, true));
        Assert.Equal(new byte[] { 58, 0, 0 }, Fm3Device.BypassBody(58, false));
        // effectId > 127 spans the septet pair
        Assert.Equal(new byte[] { 72, 1, 1 }, Fm3Device.BypassBody(200, true));
        Assert.Equal(new byte[] { 58, 0, 2 }, Fm3Device.ChannelBody(58, 2)); // channel C
    }

    [Fact]
    public void SelectCellBody_PutsGridPosAsSeptet32AtValue32()
    {
        // row 3, col 3 on 4-row grid -> gridPos = (3-1)*4 + (3-1) = 10
        var body = Fm3Device.SelectCellBody(row: 3, col: 3, rows: 4);
        Assert.Equal(0x30, body[0]);
        Assert.Equal(new byte[] { 10, 0, 0, 0, 0 }, body[6..11]); // value32 5-septet
    }

    [Fact]
    public void GridCellBody_EncodesColumnMajorGridPos()
    {
        // row 2, col 3 on a 4-row grid -> gridPos = (3-1)*4 + (2-1) = 9
        var body = Fm3Device.GridCellBody(row: 2, col: 3, blockId: 58, rows: 4);
        Assert.Equal(0x32, body[0]);
        Assert.Equal(new byte[] { 58, 0 }, body[2..4]); // blockId
        Assert.Equal(new byte[] { 9, 0 }, body[6..8]);  // gridPos
    }

    [Theory]
    // srcRow, srcCol, destRow -> expected b21, b22, b23 (FM3 4-row formula)
    [InlineData(2, 1, 2, 0, 65, 32)]  // srcGp=1: b21=0, b22=(1<<6)|1=65, b23=(2-1)<<5=32
    [InlineData(1, 2, 3, 2, 2, 64)]   // srcGp=4: b21=2, b22=(0)|2=2,    b23=(3-1)<<5=64
    [InlineData(1, 1, 1, 0, 1, 0)]    // srcGp=0: b21=0, b22=1,          b23=0
    public void GridRoutingBody_Fm3FourRowFormula(int sr, int sc, int dr, int b21, int b22, int b23)
    {
        var body = Fm3Device.GridRoutingBody(sr, sc, dr, connect: true, rows: 4);
        Assert.Equal(0x35, body[0]);
        Assert.Equal(0x01, body[6]);   // connect op
        Assert.Equal(0x02, body[13]);  // edge-record marker
        Assert.Equal((byte)b21, body[15]);
        Assert.Equal((byte)b22, body[16]);
        Assert.Equal((byte)b23, body[17]);
    }

    [Fact]
    public void GridRoutingBody_DisconnectOp()
    {
        var body = Fm3Device.GridRoutingBody(2, 1, 2, connect: false, rows: 4);
        Assert.Equal(0x02, body[6]); // disconnect op
    }

    [Fact]
    public void SwitchAndStoreBodies_PutPresetAt6()
    {
        var sw = Fm3Device.SwitchPresetBody(421); // 421 = 3*128 + 37
        Assert.Equal(0x27, sw[0]);
        Assert.Equal(new byte[] { 37, 3 }, sw[6..8]);

        var st = Fm3Device.StoreBody(100);
        Assert.Equal(0x26, st[0]);
        Assert.Equal(new byte[] { 100, 0 }, st[6..8]);
    }

    [Fact]
    public void BuildFrame_WrapsBodyWithValidEnvelopeAndChecksum()
    {
        var frame = Fm3Device.BuildFrame(0x0A, Fm3Device.BypassBody(58, true));
        var parsed = FractalSysex.ParseFrame(frame); // validates manufacturer + checksum
        Assert.NotNull(parsed);
        Assert.Equal(FractalSysex.ModelFm3, parsed!.Value.Model);
        Assert.Equal(0x0A, parsed.Value.Func);
        Assert.Equal(new byte[] { 58, 0, 1 }, parsed.Value.Body);
    }

    [Theory]
    [InlineData(0x0b, "bad grid position")]
    [InlineData(0x05, "invalid effect ID")]
    [InlineData(0x06, "invalid parameter ID")]
    public void DescribeResultCode_KnownCodes(int code, string expected)
    {
        Assert.Equal(expected, Fm3Device.DescribeResultCode(code));
    }
}
