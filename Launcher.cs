using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace CraftMateLauncher
{
    internal static class Program
    {
        private const string DashboardUrl = "http://127.0.0.1:3000";
        private const int ServerPort = 3000;
        private static readonly string LogPath =
            Path.Combine(Path.GetTempPath(), "CraftMate_launcher.log");

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
            string installDirectory = AppDomain.CurrentDomain.BaseDirectory;
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

            Log("Server is ready. Launching browser...");
            LaunchBrowser();
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
            info.RedirectStandardOutput = false;
            info.RedirectStandardError = false;

            Process server = Process.Start(info);
            if (server == null)
            {
                throw new InvalidOperationException("node.exe プロセスを起動できませんでした。");
            }
            Log("Server process started (PID " + server.Id + ").");
            server.Dispose();
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
                Thread.Sleep(1000);
            }
            return false;
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
