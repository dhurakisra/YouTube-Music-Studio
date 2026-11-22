using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

namespace SpotifyHelper;

/// <summary>
/// Deneysel (ADIM 2): Windows'un belgelenmemis IAudioPolicyConfigFactory (EarTrumpet/SoundSwitch yontemi)
/// arayuzu ile belirli bir surecin (Spotify.exe) varsayilan ses cikis cihazini degistirir ve eski haline dondurur.
/// Basarisiz olursa guvenle false + hata mesaji doner; kullanici arayuzu elle yonlendirme adimlarini gosterir.
/// </summary>
static class AudioRouter
{
    public sealed record RenderDeviceInfo(string id, string name, bool isDefault);

    // Windows 10 21H2 / Windows 11 IID (AudioPolicyConfigFactoryVariantFor21H2+)
    static readonly Guid IID_AudioPolicyConfigFactory_21H2 = new("ab3d4648-e242-459f-b02f-541c70306324");
    // Windows 10 1803 - 21H1 IID
    static readonly Guid IID_AudioPolicyConfigFactory_Downlevel = new("2a59116d-6c4f-45e0-a74f-707e3fef9258");

    const string DEVINTERFACE_AUDIO_RENDER = "{e6327cad-dcec-4949-ae8a-991e976a79d2}";

    [DllImport("combase.dll", PreserveSig = true)]
    static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string sourceString, uint length, out IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("combase.dll", PreserveSig = true)]
    static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int SetPersistedDefaultAudioEndpointDelegate(IntPtr self, uint processId, int flow, int role, IntPtr deviceIdHString);

    public static List<RenderDeviceInfo> ListRenderDevices()
    {
        var list = new List<RenderDeviceInfo>();
        try
        {
            using var en = new MMDeviceEnumerator();
            string defaultId = "";
            try { defaultId = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).ID; } catch { }
            foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                try
                {
                    list.Add(new RenderDeviceInfo(dev.ID, dev.FriendlyName, string.Equals(dev.ID, defaultId, StringComparison.OrdinalIgnoreCase)));
                }
                catch { }
            }
        }
        catch (Exception e)
        {
            Events.Warn("Cikis cihazlari listelenemedi: " + e.Message);
        }
        return list;
    }

    public static (bool ok, string? error) SetProcessOutputDevice(uint pid, string? mmDeviceId)
    {
        if (pid == 0) return (false, "Hedef Spotify PID bulunamadi");
        IntPtr classHStr = IntPtr.Zero;
        IntPtr factory = IntPtr.Zero;
        IntPtr devHStr = IntPtr.Zero;
        try
        {
            const string className = "Windows.Media.Internal.AudioPolicyConfig";
            int hr = WindowsCreateString(className, (uint)className.Length, out classHStr);
            if (hr != 0) return (false, $"WindowsCreateString(class) failed: 0x{hr:X8}");

            Guid iid = IID_AudioPolicyConfigFactory_21H2;
            hr = RoGetActivationFactory(classHStr, ref iid, out factory);
            if (hr != 0 || factory == IntPtr.Zero)
            {
                iid = IID_AudioPolicyConfigFactory_Downlevel;
                hr = RoGetActivationFactory(classHStr, ref iid, out factory);
            }
            if (hr != 0 || factory == IntPtr.Zero)
                return (false, $"IAudioPolicyConfigFactory alinamadi (HR=0x{hr:X8})");

            // mmDeviceId bos/null ise Windows varsayilanina sifirlar (devHStr = IntPtr.Zero)
            if (!string.IsNullOrWhiteSpace(mmDeviceId))
            {
                string fullId = mmDeviceId.StartsWith(@"\\?\SWD#MMDEVAPI#", StringComparison.OrdinalIgnoreCase)
                    ? mmDeviceId
                    : $@"\\?\SWD#MMDEVAPI#{mmDeviceId}#{DEVINTERFACE_AUDIO_RENDER}";
                hr = WindowsCreateString(fullId, (uint)fullId.Length, out devHStr);
                if (hr != 0) return (false, $"WindowsCreateString(device) failed: 0x{hr:X8}");
            }

            // Vtable slot 25 (Downlevel) veya 26 (21H2/Win11): SetPersistedDefaultAudioEndpoint
            IntPtr vtable = Marshal.ReadIntPtr(factory);
            int slot = iid == IID_AudioPolicyConfigFactory_21H2 ? 26 : 25;
            IntPtr fnPtr = Marshal.ReadIntPtr(vtable, slot * IntPtr.Size);
            var setEndpoint = Marshal.GetDelegateForFunctionPointer<SetPersistedDefaultAudioEndpointDelegate>(fnPtr);

            // DataFlow.Render = 0; Role.Console = 0, Role.Multimedia = 1
            int hr1 = setEndpoint(factory, pid, 0, 0, devHStr);
            int hr2 = setEndpoint(factory, pid, 0, 1, devHStr);
            if (hr1 != 0 && hr2 != 0)
                return (false, $"SetPersistedDefaultAudioEndpoint(slot={slot}) basarisiz (HR=0x{hr1:X8}/0x{hr2:X8})");

            return (true, null);
        }
        catch (Exception e)
        {
            return (false, e.Message);
        }
        finally
        {
            if (devHStr != IntPtr.Zero) WindowsDeleteString(devHStr);
            if (factory != IntPtr.Zero) Marshal.Release(factory);
            if (classHStr != IntPtr.Zero) WindowsDeleteString(classHStr);
        }
    }
}
