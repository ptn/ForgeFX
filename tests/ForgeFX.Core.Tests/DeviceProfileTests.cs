using ForgeFX.Core;

namespace ForgeFX.Core.Tests;

/// <summary>Device profiles — ForgeFX is multi-device; FM3 is the current target.</summary>
public class DeviceProfileTests
{
    [Fact]
    public void ByModel_MapsGen3ModelBytes()
    {
        Assert.Equal("FM3", FractalDevices.ByModel(0x11).Name);
        Assert.Equal("FM9", FractalDevices.ByModel(0x12).Name);
        Assert.Equal("Axe-Fx III", FractalDevices.ByModel(0x10).Name);
        Assert.Same(FractalDevices.Fm3, FractalDevices.ByModel(0x7f)); // unknown -> FM3 default
    }

    [Fact]
    public void Resolve_ById_DefaultsToFm3()
    {
        Assert.Same(FractalDevices.Fm9, FractalDevices.Resolve("fm9"));
        Assert.Same(FractalDevices.AxeFxIII, FractalDevices.Resolve("AXEFX3"));
        Assert.Same(FractalDevices.Fm3, FractalDevices.Resolve(null));
        Assert.Same(FractalDevices.Fm3, FractalDevices.Resolve("nope"));
    }

    [Fact]
    public void GridDims_PerDevice()
    {
        Assert.Equal((4, 12), (FractalDevices.Fm3.GridRows, FractalDevices.Fm3.GridCols));
        Assert.Equal((6, 14), (FractalDevices.Fm9.GridRows, FractalDevices.Fm9.GridCols));
    }
}
