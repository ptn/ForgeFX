using ForgeFX.Core;

namespace ForgeFX.Core.Tests;

/// <summary>
/// Locks the gen-3 preset codec to real FM3 preset dumps. The fixtures are
/// exported .syx preset files; the decode (dump → reassemble → Huffman → grid)
/// must reproduce the device's placement + routing.
/// </summary>
public class Fm3PresetCodecTests
{
    private static byte[] Fixture(string name) =>
        File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "fixtures", name));

    [Fact]
    public void Decode_Debug_NameModelCrc()
    {
        var p = Fm3PresetCodec.Decode(Fixture("debug.syx"));
        Assert.Equal("FM3", p.ModelName);
        Assert.Equal("DEBUG", p.Name);
        Assert.True(p.CrcValid); // stored, saved preset → CRC valid
        Assert.Equal(4, p.Rows);
        Assert.Equal(12, p.Cols);
    }

    [Fact]
    public void Decode_Debug_IsSingleRowAmpCabFilterChain()
    {
        var p = Fm3PresetCodec.Decode(Fixture("debug.syx"));
        var amp = p.Grid.Single(c => c.Name == "Amp 1");
        var cab = p.Grid.Single(c => c.Name == "Cab 1");
        var filter = p.Grid.Single(c => c.Name == "Filter 1");
        // all in one row, left-to-right
        Assert.Equal(amp.Row, cab.Row);
        Assert.Equal(amp.Row, filter.Row);
        Assert.True(amp.Col < cab.Col && cab.Col < filter.Col);
        // every non-input cell is fed from the chain's row
        Assert.Contains(amp.Row, cab.FromRows);
    }

    [Fact]
    public void Decode_Chuggings_HasParallelRoutingAndMerge()
    {
        var p = Fm3PresetCodec.Decode(Fixture("chuggings.syx"));
        Assert.Equal("Chuggings", p.Name);

        // the audio core is present
        Assert.Contains(p.Grid, c => c.Name == "Amp 1");
        Assert.Contains(p.Grid, c => c.Name == "Cab 1");

        // routing uses more than one row (parallel branches), and at least one
        // cell merges two source rows (a real wet/dry-style merge).
        Assert.True(p.Grid.Select(c => c.Row).Distinct().Count() > 1);
        Assert.Contains(p.Grid, c => c.FromRows.Length >= 2);

        // shunts (cabling cells) are present and flagged
        Assert.Contains(p.Grid, c => c.IsShunt);
    }

    [Theory]
    [InlineData(58, "Amp 1")]
    [InlineData(62, "Cab 1")]
    [InlineData(114, "Filter 1")]
    [InlineData(118, "Drive 1")]
    [InlineData(119, "Drive 2")]
    public void EffectName_ResolvesFamilyAndInstance(int eid, string expected)
    {
        Assert.Equal(expected, Fm3PresetCodec.EffectName(eid));
    }
}
