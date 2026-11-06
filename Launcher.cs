using System;
using System.Diagnostics;
using System.IO;

namespace CraftMateLauncher
{
    internal static class Program
    {
        private const string DashboardUrl = "http://localhost:3000";

        [STAThread]
        private static void Main(string[] args)
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
            Process.Start(new ProcessStartInfo(browser, arguments) { UseShellExecute = false });
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
