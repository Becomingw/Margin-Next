param([string]$ProcessName = 'margin', [string]$Label = 'window', [switch]$VerifyCloseBlocked)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class MarginNativeFrameSmoke {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  delegate bool EnumProc(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref Point p);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h,int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumProc f,IntPtr p);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int mode);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr h,IntPtr r);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
  [DllImport("gdi32.dll")] static extern bool PtInRegion(IntPtr r,int x,int y);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
  static int Hit(IntPtr h,int x,int y){return SendMessage(h,0x84,IntPtr.Zero,new IntPtr((y<<16)|(x&0xffff))).ToInt32();}
  static void CheckCutout(IntPtr root){
    IntPtr web=IntPtr.Zero;
    EnumChildWindows(root,(h,p)=>{var s=new StringBuilder(64);GetClassName(h,s,64);if(s.ToString()=="WRY_WEBVIEW"){web=h;return false;}return true;},IntPtr.Zero);
    Check(web!=IntPtr.Zero,"No native WebView child");
    Rect r;GetClientRect(web,out r);var region=CreateRectRgn(0,0,0,0);
    try{Check(GetWindowRgn(web,region)!=0,"WebView has no caption cutout");Check(!PtInRegion(region,r.Right-10,10),"WebView covers native caption controls");Check(PtInRegion(region,100,30),"Header content was clipped");}finally{DeleteObject(region);}
  }
  public static string Run(string processName,string output,string label,bool verifyCloseBlocked){
    Process found=null;
    foreach(var process in Process.GetProcessesByName(processName))if(process.MainWindowHandle!=IntPtr.Zero && process.MainWindowTitle.StartsWith("Margin")){Check(found==null,"Multiple Margin windows; specify the dedicated test process");found=process;}
    Check(found!=null,"Start the rebuilt Margin desktop app first");
    if(verifyCloseBlocked){
      SendMessage(found.MainWindowHandle,0x112,new IntPtr(0xF060),IntPtr.Zero);
      Thread.Sleep(400);Check(!found.HasExited,"Native close discarded a dirty manuscript");
      return "Native close correctly blocked while the author draft is unsaved.";
    }
    var hwnd=found.MainWindowHandle;ShowWindow(hwnd,9);SetForegroundWindow(hwnd);Thread.Sleep(200);
    Check((GetWindowLong(hwnd,-16)&0x00C00000)==0x00C00000,"Native caption styles were removed");
    Rect window;GetWindowRect(hwnd,out window);var origin=new Point();ClientToScreen(hwnd,ref origin);
    double scale=GetDpiForWindow(hwnd)/96.0;
    Check(origin.Y-window.Top<=Math.Ceiling(8*scale),"Separate standard titlebar still present");
    int y=window.Top+(int)(16*scale);
    int close=Hit(hwnd,window.Right-(int)(23*scale),y);
    int max=Hit(hwnd,window.Right-(int)(69*scale),y);
    int min=Hit(hwnd,window.Right-(int)(115*scale),y);
    Check(close==20 && max==9 && min==8,"Native caption hit testing failed: "+close+","+max+","+min);
    CheckCutout(hwnd);
    ShowWindow(hwnd,3);Thread.Sleep(200);Check(IsZoomed(hwnd),"Native maximize failed");CheckCutout(hwnd);
    ShowWindow(hwnd,9);Thread.Sleep(200);Check(!IsZoomed(hwnd),"Native restore failed");CheckCutout(hwnd);
    GetWindowRect(hwnd,out window);
    Rect client;GetClientRect(hwnd,out client);var clientOrigin=new Point();ClientToScreen(hwnd,ref clientOrigin);
    window.Left=clientOrigin.X;window.Top=clientOrigin.Y;window.Right=clientOrigin.X+client.Right;window.Bottom=clientOrigin.Y+client.Bottom;
    // Briefly expose only our test window. Never capture an occluding user's
    // application; verify ownership first and fall back to window-only capture.
    SetWindowPos(hwnd,new IntPtr(-1),0,0,0,0,0x53);Thread.Sleep(250);
    try {
      using(var image=new Bitmap(window.Right-window.Left,window.Bottom-window.Top)){
        using(var g=Graphics.FromImage(image)){
          var center=new Point{X=(window.Left+window.Right)/2,Y=(window.Top+window.Bottom)/2};
          if(GetAncestor(WindowFromPoint(center),2)==hwnd)g.CopyFromScreen(window.Left,window.Top,0,0,image.Size);
          else {var dc=g.GetHdc();try{Check(PrintWindow(hwnd,dc,2),"Could not capture the target window");}finally{g.ReleaseHdc(dc);}}
        }
        image.Save(System.IO.Path.Combine(output,"margin-"+label+".png"),ImageFormat.Png);
        var headerBg=image.GetPixel((int)(200*scale),(int)(40*scale));
        var captionBg=image.GetPixel(image.Width-(int)(10*scale),(int)(40*scale));
        Check(Math.Abs(headerBg.R-captionBg.R)<=2 && Math.Abs(headerBg.G-captionBg.G)<=2 && Math.Abs(headerBg.B-captionBg.B)<=2,"Native caption and application header use different surfaces");
        foreach(int offset in new int[]{23,69,115}){
          int cx=image.Width-(int)(offset*scale),cy=(int)(16*scale),radius=(int)(12*scale);int low=255,high=0;
          for(int yy=Math.Max(0,cy-radius);yy<Math.Min(image.Height,cy+radius);yy++)for(int xx=Math.Max(0,cx-radius);xx<Math.Min(image.Width,cx+radius);xx++){
            var color=image.GetPixel(xx,yy);int light=(color.R+color.G+color.B)/3;low=Math.Min(low,light);high=Math.Max(high,light);
          }
          Check(high-low>50,"Native caption glyph has insufficient contrast at offset "+offset);
        }
      }
    } finally {SetWindowPos(hwnd,new IntPtr(-2),0,0,0,0,0x13);}
    var big=SendMessage(hwnd,0x7f,new IntPtr(1),IntPtr.Zero);var small=SendMessage(hwnd,0x7f,IntPtr.Zero,IntPtr.Zero);
    Check(big!=IntPtr.Zero && small!=IntPtr.Zero,"Native application icon missing");
    using(var icon=(Icon)Icon.FromHandle(big).Clone())using(var image=new Bitmap(64,64)){
      using(var g=Graphics.FromImage(image)){g.Clear(Color.Transparent);g.DrawIcon(icon,new Rectangle(0,0,64,64));}
      var blue=image.GetPixel(32,14);Check(blue.B>180 && blue.R<110 && blue.G>80,"Native icon is stale, not the new blue artwork");
      image.Save(System.IO.Path.Combine(output,"margin-native-icon.png"),ImageFormat.Png);
    }
    using(var icon=Icon.ExtractAssociatedIcon(found.MainModule.FileName))using(var image=new Bitmap(64,64)){
      using(var g=Graphics.FromImage(image)){g.Clear(Color.Transparent);g.DrawIcon(icon,new Rectangle(0,0,64,64));}
      var blue=image.GetPixel(32,14);Check(blue.B>180 && blue.R<110 && blue.G>80,"EXE resource icon is stale");
    }
    return "Native frame passed: one titlebar, real minimize/maximize/close hit targets, WebView cutout, maximize/restore and updated HWND icon. PID="+found.Id;
  }
}
'@
$output = Join-Path $PSScriptRoot '../artifacts'
[void][System.IO.Directory]::CreateDirectory($output)
[MarginNativeFrameSmoke]::Run($ProcessName, $output, $Label, $VerifyCloseBlocked.IsPresent)
