using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

namespace CraftMateLauncher
{
    internal static class Program
    {
        private const string DashboardUrl = "http://localhost:3000";

        // コンソール版(/target:exe)でビルドした場合にデバッグログを出力する。
        // winexe版ではコンソールが無いため出力は破棄される。
        private static void Log(string message)
        {
            try { Console.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message); } catch { }
        }

        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                string installDirectory = AppDomain.CurrentDomain.BaseDirectory;
                Log("Install directory: " + installDirectory);
                if (!IsDashboardReady() && !IsPortOpen())
                {
                    Log("Dashboard is not running. Starting server...");
                    StartServer(installDirectory);
                }
                else
                {
                    Log("Dashboard server is already running.");
                }

                if (!WaitForDashboard())
                {
                    Log("ERROR: Dashboard did not become ready on port 3000.");
                    MessageBox.Show(
                        "CraftMate server did not become ready on port 3000. Check the installation and try again.",
                        "CraftMate",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return;
                }

                Log("Dashboard is ready. Launching browser...");
                LaunchBrowser();
            }
            catch (Exception error)
            {
                Log("ERROR: " + error);
                MessageBox.Show("Could not start CraftMate: " + error.Message, "CraftMate", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void StartServer(string installDirectory)
        {
            string nodePath = Path.Combine(installDirectory, "node.exe");
            string entryPoint = Path.Combine(installDirectory, "dist", "index.js");
            if (!File.Exists(nodePath) || !File.Exists(entryPoint))
            {
                throw new FileNotFoundException("CraftMate's Node.js runtime or server entry point is missing.");
            }

            ProcessStartInfo serverInfo = new ProcessStartInfo();
            serverInfo.FileName = nodePath;
            serverInfo.Arguments = "\"dist\\index.js\"";
            serverInfo.WorkingDirectory = installDirectory;
            serverInfo.UseShellExecute = false;
            serverInfo.CreateNoWindow = true;
            serverInfo.WindowStyle = ProcessWindowStyle.Hidden;
            Process server = Process.Start(serverInfo);
            if (server == null)
            {
                throw new InvalidOperationException("Windows could not start the CraftMate server process.");
            }
            Log("Server process started (PID " + server.Id + ").");
            server.Dispose();
        }

        private static bool IsPortOpen()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    client.Connect("127.0.0.1", 3000);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool IsDashboardReady()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(DashboardUrl + "/api/status");
                request.Timeout = 500;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool WaitForDashboard()
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(15);
            while (DateTime.UtcNow < deadline)
            {
                if (IsDashboardReady()) return true;
                Thread.Sleep(500);
            }
            return false;
        }

        private static void LaunchBrowser()
        {
            string browser = FindBrowser();
            if (browser == null)
            {
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
                // Firefox など Chromium 系でないブラウザは --app= を解釈できないため通常起動
                bool chromium = IsChromiumBrowser(browser);
                if (!chromium)
                {
                    Process.Start(new ProcessStartInfo(browser, "\"" + DashboardUrl + "\"") { UseShellExecute = false });
                    return;
                }

                string profileDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "CraftMate",
                    "BrowserProfile");
                Directory.CreateDirectory(profileDirectory);

                string arguments = "--app=\"" + DashboardUrl + "\" --user-data-dir=\"" +
                    profileDirectory + "\" --no-first-run --no-default-browser-check";

                // Chromium has no supported --icon switch for arbitrary app-mode URLs.
                // The PWA manifest and page favicon provide the CraftMate icon instead.
                Process browserProcess = Process.Start(new ProcessStartInfo(browser, arguments) { UseShellExecute = false });
                if (browserProcess == null)
                {
                    throw new InvalidOperationException("Windows could not start the browser.");
                }
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

        private static bool IsChromiumBrowser(string browserPath)
        {
            string name = Path.GetFileName(browserPath).ToLowerInvariant();
            return name.Contains("chrome") || name.Contains("msedge") || name.Contains("brave")
                || name.Contains("vivaldi") || name.Contains("opera") || name.Contains("chromium");
        }

        private static IEnumerable<string> BrowserCandidates()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

            // 優先順位: Chrome → Edge → Brave → Vivaldi → Opera → Firefox
            foreach (string dir in new[] { pf, pf86, local })
                yield return Path.Combine(dir, "Google", "Chrome", "Application", "chrome.exe");
            foreach (string dir in new[] { pf, pf86, local })
                yield return Path.Combine(dir, "Microsoft", "Edge", "Application", "msedge.exe");
            foreach (string dir in new[] { pf, pf86, local })
                yield return Path.Combine(dir, "BraveSoftware", "Brave-Browser", "Application", "brave.exe");
            foreach (string dir in new[] { pf, pf86, local })
                yield return Path.Combine(dir, "Vivaldi", "Application", "vivaldi.exe");
            foreach (string dir in new[] { pf, pf86, local })
                yield return Path.Combine(dir, "Programs", "Opera", "opera.exe");
            foreach (string dir in new[] { pf, pf86, local, roaming })
                yield return Path.Combine(dir, "Mozilla Firefox", "firefox.exe");
        }

        private static string FindBrowser()
        {
            foreach (string candidate in BrowserCandidates())
            {
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }
    }
}
