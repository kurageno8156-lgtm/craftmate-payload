using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CraftMateLauncher
{
    internal static class Program
    {
        private const string DashboardUrl = "http://127.0.0.1:3000";
        private const int ServerPort = 3000;
        private static readonly string LogPath =
            Path.Combine(Path.GetTempPath(), "CraftMate_launcher.log");
        private static Process _serverProcess;

        private static void Log(string message)
        {
            try
            {
                string line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message;
                Console.WriteLine(line);
                File.AppendAllText(LogPath, line + Environment.NewLine);
            }
            catch { }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Run();
                return 0;
            }
            catch (Exception ex)
            {
                Log("FATAL: " + ex);
                try
                {
                    MessageBox.Show(
                        "CraftMate を起動できませんでした: " + ex.Message +
                        Environment.NewLine + Environment.NewLine +
                        "詳細ログ: " + LogPath,
                        "CraftMate",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }
                catch { }
                return 1;
            }
        }

        private static void Run()
        {
            string installDirectory = ResolveInstallDirectory();
            Log("Install directory: " + installDirectory);
            Log("Log file: " + LogPath);

            // サーバーが既に動いているか確認。動いていなければ起動する。
            if (IsServerReady())
            {
                Log("Server is already running on port " + ServerPort + ".");
            }
            else
            {
                Log("Server is not running. Starting node.exe dist\\index.js ...");
                StartServer(installDirectory);
            }

            if (!WaitForServer())
            {
                Log("ERROR: Server did not become ready on port " + ServerPort + ".");
                MessageBox.Show(
                    "CraftMate server did not become ready on port " + ServerPort +
                    ". Check the installation and try again." +
                    Environment.NewLine + Environment.NewLine +
                    "詳細ログ: " + LogPath,
                    "CraftMate",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            // TCPは開いているがHTTPが応答しない「 wedged 」状態のサーバーを検出する。
            // この状態ではダッシュボードのボタンが全て反応しなくなるため、起動を中止して再起動を促す。
            if (!VerifyDashboardHttp())
            {
                Log("ERROR: Server accepts TCP connections but does not respond to HTTP.");
                MessageBox.Show(
                    "CraftMate server is not responding. Another instance may be stuck." +
                    Environment.NewLine + "Please restart CraftMate (or reboot the PC) and try again." +
                    Environment.NewLine + Environment.NewLine +
                    "詳細ログ: " + LogPath,
                    "CraftMate",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            Log("Server is ready. Launching browser...");
            LaunchBrowser();
        }

        /// <summary>
        /// 実行ファイルと同じディレクトリを優先し、node.exe / dist\index.js が
        /// 無い場合はレジストリの InstallLocation、最後に既定のインストール先を試す。
        /// 開発フォルダや古いコピーから起動されても正しいインストール先を使えるようにする。
        /// </summary>
        private static string ResolveInstallDirectory()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            if (HasServerFiles(baseDir)) return baseDir;

            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CraftMate", false))
                {
                    string installLocation = key == null ? null : key.GetValue("InstallLocation") as string;
                    if (!string.IsNullOrEmpty(installLocation) && HasServerFiles(installLocation))
                    {
                        Log("Using registry InstallLocation: " + installLocation);
                        return installLocation;
                    }
                }
            }
            catch (Exception ex)
            {
                Log("Registry lookup failed: " + ex.Message);
            }

            string fallback = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "CraftMate");
            if (HasServerFiles(fallback))
            {
                Log("Using default install location: " + fallback);
                return fallback;
            }

            Log("WARNING: No valid install directory found; falling back to " + baseDir);
            return baseDir;
        }

        private static bool HasServerFiles(string directory)
        {
            try
            {
                return !string.IsNullOrEmpty(directory)
                    && File.Exists(Path.Combine(directory, "node.exe"))
                    && File.Exists(Path.Combine(directory, "dist", "index.js"));
            }
            catch { return false; }
        }

        private static void StartServer(string installDirectory)
        {
            string nodePath = Path.Combine(installDirectory, "node.exe");
            string entryPoint = Path.Combine(installDirectory, "dist", "index.js");
            if (!File.Exists(nodePath))
            {
                throw new FileNotFoundException("node.exe が見つかりません: " + nodePath);
            }
            if (!File.Exists(entryPoint))
            {
                throw new FileNotFoundException("dist\\index.js が見つかりません: " + entryPoint);
            }

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = nodePath;
            info.Arguments = "\"dist\\index.js\"";
            info.WorkingDirectory = installDirectory;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;

            Process server = Process.Start(info);
            if (server == null)
            {
                throw new InvalidOperationException("node.exe プロセスを起動できませんでした。");
            }
            _serverProcess = server;

            // サーバーの標準出力/エラーをログに転記し、起動失敗の原因を追跡できるようにする
            server.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("[server] " + e.Data);
            };
            server.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("[server:err] " + e.Data);
            };
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

            Log("Server process started (PID " + server.Id + ").");
        }

        /// <summary>
        /// 127.0.0.1:3000 への TCP 接続でサーバーの生存を確認する。
        /// HTTPではなくTCPなので、APIの応答内容に関わらず判定できる。
        /// </summary>
        private static bool IsServerReady()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", ServerPort, null, null);
                    bool connected = result.AsyncWaitHandle.WaitOne(1000);
                    if (connected && client.Connected)
                    {
                        try { client.EndConnect(result); } catch { }
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                Log("TCP check failed: " + ex.Message);
            }
            return false;
        }

        private static bool WaitForServer()
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(120);
            while (DateTime.UtcNow < deadline)
            {
                if (IsServerReady()) return true;

                // サーバープロセスが早期に終了した場合は待たずに失敗とする
                if (_serverProcess != null)
                {
                    try
                    {
                        if (_serverProcess.HasExited)
                        {
                            Log("ERROR: Server process exited early (code " + _serverProcess.ExitCode + ").");
                            return false;
                        }
                    }
                    catch { }
                }
                Thread.Sleep(1000);
            }
            return false;
        }

        /// <summary>
        /// TCP接続は成功するがHTTPが応答しない「wedged」状態のサーバーを検出する。
        /// GET /api/version に加え、body付きPOST（/api/command に空JSON）でも応答を確認する。
        /// body解析でハングするサーバーはダッシュボードの全ボタンが無反応になるため起動を中止する。
        /// </summary>
        private static bool VerifyDashboardHttp()
        {
            // 1) GET /api/version でHTTP自体が生きているか確認
            bool getOk = false;
            for (int attempt = 0; attempt < 3 && !getOk; attempt++)
            {
                try
                {
                    System.Net.HttpWebRequest request =
                        (System.Net.HttpWebRequest)System.Net.WebRequest.Create(DashboardUrl + "/api/version");
                    request.Timeout = 3000;
                    request.ReadWriteTimeout = 3000;
                    using (System.Net.HttpWebResponse response =
                        (System.Net.HttpWebResponse)request.GetResponse())
                    {
                        getOk = (int)response.StatusCode < 500;
                    }
                }
                catch (System.Net.WebException webError)
                {
                    if (webError.Response != null)
                    {
                        try { webError.Response.Close(); } catch { }
                        getOk = true; // HTTPエラー応答 = サーバーは生きている
                    }
                    else Log("GET /api/version attempt " + (attempt + 1) + " failed: " + webError.Message);
                }
                catch (Exception ex)
                {
                    Log("GET /api/version attempt " + (attempt + 1) + " failed: " + ex.Message);
                }
                if (!getOk) Thread.Sleep(1000);
            }
            if (!getOk)
            {
                Log("ERROR: /api/version did not respond.");
                return false;
            }
            Log("GET /api/version OK.");

            // 2) body付きPOSTでbody解析のハングを検出（/api/command は空instructionで400を返すだけで副作用なし）
            try
            {
                System.Net.HttpWebRequest post =
                    (System.Net.HttpWebRequest)System.Net.WebRequest.Create(DashboardUrl + "/api/command");
                post.Method = "POST";
                post.ContentType = "application/json";
                post.Timeout = 5000;
                post.ReadWriteTimeout = 5000;
                byte[] body = System.Text.Encoding.UTF8.GetBytes("{}");
                post.ContentLength = body.Length;
                using (System.IO.Stream stream = post.GetRequestStream())
                {
                    stream.Write(body, 0, body.Length);
                }
                try
                {
                    using (System.Net.HttpWebResponse response =
                        (System.Net.HttpWebResponse)post.GetResponse())
                    {
                        Log("POST probe OK: /api/command -> " + (int)response.StatusCode);
                        return true;
                    }
                }
                catch (System.Net.WebException postError)
                {
                    if (postError.Response != null)
                    {
                        // 4xx/5xx でも応答があればbody解析は機能している
                        try { postError.Response.Close(); } catch { }
                        Log("POST probe OK (error response): server parses request bodies.");
                        return true;
                    }
                    Log("ERROR: POST probe failed: " + postError.Message);
                    return false;
                }
            }
            catch (Exception ex)
            {
                Log("ERROR: POST probe exception: " + ex.Message);
                return false;
            }
        }

        private static void LaunchBrowser()
        {
            string browser = FindBrowser();
            if (browser == null)
            {
                Log("ERROR: No supported browser found.");
                MessageBox.Show(
                    "開けるブラウザが見つかりません。ChromeかEdgeをインストールしてください。",
                    "CraftMate",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }
            Log("Browser: " + browser);

            try
            {
                string profileDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "CraftMate",
                    "BrowserProfile");
                Directory.CreateDirectory(profileDirectory);

                // --app= でデスクトップアプリ風に開く。Chrome/Edge はどちらもChromium系。
                string arguments =
                    "--app=" + DashboardUrl +
                    " --user-data-dir=\"" + profileDirectory + "\"" +
                    " --no-first-run --no-default-browser-check";

                Process browserProcess = Process.Start(
                    new ProcessStartInfo(browser, arguments) { UseShellExecute = false });
                if (browserProcess == null)
                {
                    throw new InvalidOperationException("ブラウザプロセスを起動できませんでした。");
                }
                Log("Browser launched (PID " + browserProcess.Id + ").");
                browserProcess.Dispose();
            }
            catch (Exception browserError)
            {
                Log("Browser launch failed: " + browserError);
                MessageBox.Show(
                    "ブラウザの起動に失敗しました: " + browserError.Message,
                    "CraftMate",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private static string FindBrowser()
        {
            // 優先順位: Chrome → Edge
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

            string[] bases = new string[] { pf, pf86, local };
            foreach (string dir in bases)
            {
                string chrome = Path.Combine(dir, "Google", "Chrome", "Application", "chrome.exe");
                if (File.Exists(chrome)) return chrome;
            }
            foreach (string dir in bases)
            {
                string edge = Path.Combine(dir, "Microsoft", "Edge", "Application", "msedge.exe");
                if (File.Exists(edge)) return edge;
            }
            return null;
        }
    }
}
