using System;
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

        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                string installDirectory = AppDomain.CurrentDomain.BaseDirectory;
                if (!IsDashboardReady() && !IsPortOpen())
                {
                    StartServer(installDirectory);
                }

                if (!WaitForDashboard())
                {
                    MessageBox.Show(
                        "CraftMate server did not become ready on port 3000. Check the installation and try again.",
                        "CraftMate",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return;
                }

                LaunchBrowser();
            }
            catch (Exception error)
            {
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
                Process.Start(new ProcessStartInfo(DashboardUrl) { UseShellExecute = true });
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
                throw new InvalidOperationException("Windows could not start Edge or Chrome.");
            }
            browserProcess.Dispose();
        }

        private static string FindBrowser()
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
            };

            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }
    }
}
