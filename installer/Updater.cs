using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CraftMateUpdater
{
    internal static class Program
    {
        private static string GetInstallDirectory(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--worker" || args[i] == "--install-dir")
                    return Path.GetFullPath(args[i + 1]);
            }
            return Path.GetDirectoryName(Application.ExecutablePath);
        }

        private static bool IsAdministrator()
        {
            try
            {
                WindowsIdentity identity = WindowsIdentity.GetCurrent();
                WindowsPrincipal principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string installDirectory = GetInstallDirectory(args);
            bool isWorker = args.Length > 0 && args[0] == "--worker";

            if (!isWorker)
            {
                try
                {
                    string workerDirectory = Path.Combine(Path.GetTempPath(), "CraftMateUpdater-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(workerDirectory);
                    string workerPath = Path.Combine(workerDirectory, "CraftMate_Updater.exe");
                    File.Copy(Application.ExecutablePath, workerPath, true);
                    ProcessStartInfo startInfo = new ProcessStartInfo();
                    startInfo.FileName = workerPath;
                    startInfo.Arguments = "--worker " + QuoteArgument(installDirectory);
                    startInfo.WorkingDirectory = workerDirectory;
                    startInfo.UseShellExecute = true;
                    if (!IsAdministrator()) startInfo.Verb = "runas";
                    Process.Start(startInfo);
                }
                catch (Win32Exception error)
                {
                    MessageBox.Show(
                        error.NativeErrorCode == 1223 ? "管理者権限が許可されなかったため、更新を開始しませんでした。" : "アップデーターを起動できませんでした: " + error.Message,
                        "CraftMate Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                catch (Exception error)
                {
                    MessageBox.Show("アップデーターを起動できませんでした: " + error.Message,
                        "CraftMate Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return;
            }

            Application.Run(new UpdaterForm(installDirectory));
        }
    }

    internal sealed class UpdaterForm : Form
    {
        private enum UpdateOutcome
        {
            UpToDate,
            Declined,
            Updated
        }

        private const string Repository = "kurageno8156-lgtm/craftmate-payload";
        private const long MaximumArchiveBytes = 512L * 1024L * 1024L;
        private readonly string _installDirectory;
        private readonly TextBox _log;
        private readonly ProgressBar _progress;
        private readonly Label _status;
        private readonly Button _closeButton;
        private readonly BackgroundWorker _worker;
        private bool _started;

        public UpdaterForm(string installDirectory)
        {
            _installDirectory = Path.GetFullPath(installDirectory);
            Text = "CraftMate Updater";
            Width = 620;
            Height = 430;
            MinimumSize = new System.Drawing.Size(520, 360);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            Label heading = new Label();
            heading.Text = "CraftMate アップデーター";
            heading.Font = new System.Drawing.Font("Segoe UI", 14, System.Drawing.FontStyle.Bold);
            heading.Location = new System.Drawing.Point(18, 14);
            heading.Size = new System.Drawing.Size(560, 30);
            Controls.Add(heading);

            _status = new Label();
            _status.Text = "更新を準備しています...";
            _status.Location = new System.Drawing.Point(20, 55);
            _status.Size = new System.Drawing.Size(565, 24);
            Controls.Add(_status);

            _progress = new ProgressBar();
            _progress.Location = new System.Drawing.Point(20, 83);
            _progress.Size = new System.Drawing.Size(565, 20);
            _progress.Minimum = 0;
            _progress.Maximum = 100;
            _progress.Style = ProgressBarStyle.Continuous;
            Controls.Add(_progress);

            _log = new TextBox();
            _log.Location = new System.Drawing.Point(20, 116);
            _log.Size = new System.Drawing.Size(565, 230);
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.WordWrap = false;
            _log.Font = new System.Drawing.Font("Consolas", 9);
            Controls.Add(_log);

            _closeButton = new Button();
            _closeButton.Text = "閉じる";
            _closeButton.Location = new System.Drawing.Point(490, 355);
            _closeButton.Size = new System.Drawing.Size(95, 30);
            _closeButton.Enabled = false;
            _closeButton.Click += delegate { Close(); };
            Controls.Add(_closeButton);

            _worker = new BackgroundWorker();
            _worker.WorkerReportsProgress = true;
            _worker.DoWork += UpdateWorker_DoWork;
            _worker.ProgressChanged += UpdateWorker_ProgressChanged;
            _worker.RunWorkerCompleted += UpdateWorker_Completed;
            Shown += UpdaterForm_Shown;
        }

        private void UpdaterForm_Shown(object sender, EventArgs e)
        {
            if (_started) return;
            _started = true;
            _worker.RunWorkerAsync();
        }

        private void UpdateWorker_DoWork(object sender, DoWorkEventArgs e)
        {
            BackgroundWorker worker = (BackgroundWorker)sender;
            e.Result = ApplyLatestUpdate(worker);
        }

        private void UpdateWorker_ProgressChanged(object sender, ProgressChangedEventArgs e)
        {
            if (e.ProgressPercentage >= 0 && e.ProgressPercentage <= 100) _progress.Value = e.ProgressPercentage;
            string message = e.UserState as string;
            if (String.IsNullOrEmpty(message)) return;
            _status.Text = message;
            _log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + message + Environment.NewLine);
            _log.SelectionStart = _log.TextLength;
            _log.ScrollToCaret();
        }

        private void UpdateWorker_Completed(object sender, RunWorkerCompletedEventArgs e)
        {
            if (e.Error != null)
            {
                _status.Text = "アップデートに失敗しました。ログを確認してください。";
                _log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  エラー: " + e.Error.Message + Environment.NewLine);
                _status.ForeColor = System.Drawing.Color.DarkRed;
            }
            else if (e.Result is UpdateOutcome && (UpdateOutcome)e.Result == UpdateOutcome.Updated)
            {
                _progress.Value = 100;
                _status.Text = "アップデートが完了し、CraftMateを再起動しました。";
                _status.ForeColor = System.Drawing.Color.DarkGreen;
            }
            else if (e.Result is UpdateOutcome && (UpdateOutcome)e.Result == UpdateOutcome.Declined)
            {
                _status.Text = "アップデートをキャンセルしました。";
            }
            else
            {
                _progress.Value = 100;
                _status.Text = "CraftMate は最新バージョンです。";
                _status.ForeColor = System.Drawing.Color.DarkGreen;
            }
            _closeButton.Enabled = true;
        }

        private void Report(BackgroundWorker worker, int percent, string message)
        {
            worker.ReportProgress(Math.Max(0, Math.Min(100, percent)), message);
        }

        private UpdateOutcome ApplyLatestUpdate(BackgroundWorker worker)
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            if (!Directory.Exists(_installDirectory)) throw new DirectoryNotFoundException("インストール先が見つかりません: " + _installDirectory);
            Report(worker, 2, "インストール済みバージョンを確認しています...");
            string packagePath = Path.Combine(_installDirectory, "package.json");
            if (!File.Exists(packagePath)) throw new FileNotFoundException("現在のバージョン情報がありません。", packagePath);
            Dictionary<string, object> installedPackage = DeserializeObject(File.ReadAllText(packagePath));
            string installedVersion = Convert.ToString(installedPackage["version"]);

            Report(worker, 5, "GitHub Releases を確認しています...");
            string apiUrl = "https://api.github.com/repos/" + Repository + "/releases/latest";
            HttpWebRequest apiRequest = (HttpWebRequest)WebRequest.Create(apiUrl);
            apiRequest.UserAgent = "CraftMate-Updater";
            apiRequest.Accept = "application/vnd.github+json";
            apiRequest.Timeout = 30000;
            apiRequest.ReadWriteTimeout = 30000;
            string releaseJson;
            using (HttpWebResponse response = (HttpWebResponse)apiRequest.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream)) releaseJson = reader.ReadToEnd();

            Dictionary<string, object> release = DeserializeObject(releaseJson);
            string tag = Convert.ToString(release["tag_name"]);
            Match versionMatch = Regex.Match(tag ?? String.Empty, "^v?(\\d+\\.\\d+\\.\\d+)");
            if (!versionMatch.Success) throw new InvalidDataException("GitHub のリリースタグが不正です: " + tag);
            string latestVersion = versionMatch.Groups[1].Value;
            Report(worker, 8, "バージョンを比較しています: 現在 v" + installedVersion + " / 最新 v" + latestVersion);
            if (CompareVersions(latestVersion, installedVersion) <= 0)
            {
                Report(worker, 100, "CraftMate は最新バージョンです (v" + installedVersion + ")。");
                return UpdateOutcome.UpToDate;
            }

            if (!ConfirmUpdate(latestVersion, installedVersion))
            {
                Report(worker, 100, "アップデートをキャンセルしました。");
                return UpdateOutcome.Declined;
            }

            string downloadUrl = FindPayloadUrl(release);
            string workDirectory = Path.Combine(Path.GetTempPath(), "CraftMateUpdate-" + Guid.NewGuid().ToString("N"));
            string archivePath = Path.Combine(workDirectory, "app_payload.zip");
            string stageDirectory = Path.Combine(workDirectory, "stage");
            string backupDirectory = Path.Combine(workDirectory, "backup");
            Directory.CreateDirectory(workDirectory);
            Directory.CreateDirectory(stageDirectory);
            List<FileChange> changes = new List<FileChange>();

            try
            {
                DownloadPayload(worker, downloadUrl, archivePath);
                Report(worker, 58, "ZIP 内のパスとバージョンを検証しています...");
                ExtractSafely(archivePath, stageDirectory, worker);
                try { File.Delete(archivePath); } catch { }
                string stagedPackagePath = Path.Combine(stageDirectory, "package.json");
                if (!File.Exists(stagedPackagePath)) throw new InvalidDataException("ZIP に package.json がありません。");
                Dictionary<string, object> stagedPackage = DeserializeObject(File.ReadAllText(stagedPackagePath));
                if (CompareVersions(Convert.ToString(stagedPackage["version"]), latestVersion) != 0)
                    throw new InvalidDataException("ZIP 内のバージョンが GitHub リリースと一致しません。");
                foreach (string required in new string[] { "CraftMate.exe", "CraftMate_Updater.exe", "node.exe", "dist\\index.js", "public\\app.ico" })
                    if (!File.Exists(Path.Combine(stageDirectory, required))) throw new FileNotFoundException("更新ファイルが不足しています: " + required);

                StopInstalledNode(worker);
                StopInstalledLauncher(worker);
                string[] updateItems = new string[] { "dist", "public", "node_modules", "CraftMate.exe", "CraftMate_Updater.exe", "node.exe", ".env.example", "package.json", "package-lock.json", "README.md", "Uninstall.exe" };
                int total = updateItems.Length;
                for (int i = 0; i < updateItems.Length; i++)
                {
                    string item = updateItems[i];
                    string source = Path.Combine(stageDirectory, item);
                    if (!File.Exists(source) && !Directory.Exists(source)) continue;
                    string destination = Path.Combine(_installDirectory, item);
                    string backup = Path.Combine(backupDirectory, item);
                    bool hadBackup = File.Exists(destination) || Directory.Exists(destination);
                    Directory.CreateDirectory(Path.GetDirectoryName(backup));
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    changes.Add(new FileChange(destination, backup, hadBackup, Directory.Exists(destination)));
                    if (hadBackup)
                    {
                        if (Directory.Exists(destination)) Directory.Move(destination, backup);
                        else File.Move(destination, backup);
                    }
                    if (Directory.Exists(source)) Directory.Move(source, destination);
                    else File.Move(source, destination);
                    Report(worker, 65 + (int)(((i + 1) / (double)total) * 30), "インストール先を更新中... " + item);
                }

                Dictionary<string, object> verifiedPackage = DeserializeObject(File.ReadAllText(packagePath));
                string verifiedVersion = Convert.ToString(verifiedPackage["version"]);
                if (CompareVersions(verifiedVersion, latestVersion) != 0) throw new InvalidDataException("更新後のバージョン確認に失敗しました。");
                StartInstalledLauncher();
                Report(worker, 100, "アップデートが完了しました (v" + verifiedVersion + ")。");
                return UpdateOutcome.Updated;
            }
            catch
            {
                RollBack(changes);
                throw;
            }
            finally
            {
                try { Directory.Delete(workDirectory, true); } catch { }
            }
        }

        private bool ConfirmUpdate(string latestVersion, string installedVersion)
        {
            bool confirmed = false;
            Invoke(new MethodInvoker(delegate
            {
                DialogResult answer = MessageBox.Show(
                    this,
                    "CraftMate の新しいバージョン v" + latestVersion + " があります (現在 v" + installedVersion + ")。\r\n本当にアップデートしますか？",
                    "CraftMate Updater",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button2);
                confirmed = answer == DialogResult.Yes;
            }));
            return confirmed;
        }

        private static Dictionary<string, object> DeserializeObject(string json)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 8 * 1024 * 1024;
            Dictionary<string, object> value = serializer.DeserializeObject(json) as Dictionary<string, object>;
            if (value == null) throw new InvalidDataException("JSON データを読み取れません。");
            return value;
        }

        private static string FindPayloadUrl(Dictionary<string, object> release)
        {
            object[] assets = release.ContainsKey("assets") ? release["assets"] as object[] : null;
            if (assets == null) throw new InvalidDataException("GitHub リリースにアセットがありません。");
            foreach (object assetObject in assets)
            {
                Dictionary<string, object> asset = assetObject as Dictionary<string, object>;
                if (asset == null || !asset.ContainsKey("name") || Convert.ToString(asset["name"]) != "app_payload.zip") continue;
                string url = Convert.ToString(asset["browser_download_url"]);
                Uri parsed;
                if (!Uri.TryCreate(url, UriKind.Absolute, out parsed) || parsed.Scheme != Uri.UriSchemeHttps ||
                    !String.Equals(parsed.Host, "github.com", StringComparison.OrdinalIgnoreCase) ||
                    !parsed.AbsolutePath.Contains("/releases/download/"))
                    throw new InvalidDataException("更新パッケージ URL が信頼できません。");
                return url;
            }
            throw new InvalidDataException("GitHub リリースに app_payload.zip がありません。");
        }

        private void DownloadPayload(BackgroundWorker worker, string url, string destination)
        {
            Report(worker, 10, "GitHub から app_payload.zip をダウンロードしています...");
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "CraftMate-Updater";
            request.Timeout = 600000;
            request.ReadWriteTimeout = 120000;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream input = response.GetResponseStream())
            using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                long total = response.ContentLength;
                if (total > MaximumArchiveBytes) throw new InvalidDataException("更新 ZIP が上限サイズを超えています。");
                byte[] buffer = new byte[65536];
                long received = 0;
                int read;
                int lastPercent = -1;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    received += read;
                    if (received > MaximumArchiveBytes) throw new InvalidDataException("更新 ZIP が上限サイズを超えています。");
                    output.Write(buffer, 0, read);
                    int percent = total > 0 ? (int)(received * 100 / total) : 0;
                    if (percent >= lastPercent + 5)
                    {
                        lastPercent = percent;
                        Report(worker, 10 + (int)(percent * 0.42), "ダウンロード中... " + percent + "%");
                    }
                }
            }
            byte[] signature = new byte[4];
            using (FileStream file = File.OpenRead(destination))
            {
                if (file.Read(signature, 0, signature.Length) != signature.Length ||
                    !(signature[0] == 0x50 && signature[1] == 0x4B))
                    throw new InvalidDataException("ダウンロードしたファイルは有効な ZIP ではありません。");
            }
            Report(worker, 54, "ダウンロードが完了しました。ZIP を解凍しています...");
        }

        private void ExtractSafely(string archivePath, string stageDirectory, BackgroundWorker worker)
        {
            string root = Path.GetFullPath(stageDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            using (ZipArchive archive = ZipFile.OpenRead(archivePath))
            {
                int count = 0;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string destination = Path.GetFullPath(Path.Combine(stageDirectory, entry.FullName));
                    if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("ZIP に展開先外を指すパスがあります。");
                    int unixType = (entry.ExternalAttributes >> 16) & 0xF000;
                    if (unixType == 0xA000) throw new InvalidDataException("ZIP にシンボリックリンクは許可されていません。");
                    if (String.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(destination);
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                        entry.ExtractToFile(destination, true);
                    }
                    count++;
                    if (count % 100 == 0) Report(worker, 58, "ZIP を解凍中... " + count + " entries");
                }
            }
            Report(worker, 62, "ZIP の解凍が完了しました。ファイルを置き換えています...");
        }

        private void StopInstalledNode(BackgroundWorker worker)
        {
            string expectedNode = Path.GetFullPath(Path.Combine(_installDirectory, "node.exe"));
            Report(worker, 64, "実行中の CraftMate サーバーを停止しています...");
            foreach (Process process in Process.GetProcessesByName("node"))
            {
                try
                {
                    string executable = process.MainModule.FileName;
                    if (!String.Equals(Path.GetFullPath(executable), expectedNode, StringComparison.OrdinalIgnoreCase)) continue;
                    process.Kill();
                    if (!process.WaitForExit(15000)) throw new IOException("CraftMate サーバーを停止できませんでした。");
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception error)
                {
                    throw new IOException("実行中の CraftMate サーバーを停止できません: " + error.Message);
                }
                finally { process.Dispose(); }
            }
            Thread.Sleep(500);
        }

        private void StopInstalledLauncher(BackgroundWorker worker)
        {
            string expectedLauncher = Path.GetFullPath(Path.Combine(_installDirectory, "CraftMate.exe"));
            Report(worker, 64, "起動中の CraftMate を終了しています...");
            foreach (Process process in Process.GetProcessesByName("CraftMate"))
            {
                try
                {
                    string executable = process.MainModule.FileName;
                    if (!String.Equals(Path.GetFullPath(executable), expectedLauncher, StringComparison.OrdinalIgnoreCase)) continue;
                    process.Kill();
                    if (!process.WaitForExit(15000)) throw new IOException("起動中の CraftMate を終了できませんでした。");
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception error)
                {
                    throw new IOException("起動中の CraftMate を終了できません: " + error.Message);
                }
                finally { process.Dispose(); }
            }
            Thread.Sleep(500);
        }

        private void StartInstalledLauncher()
        {
            string launcherPath = Path.Combine(_installDirectory, "CraftMate.exe");
            if (!File.Exists(launcherPath)) throw new FileNotFoundException("更新後の CraftMate.exe が見つかりません。", launcherPath);
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = launcherPath;
            startInfo.WorkingDirectory = _installDirectory;
            startInfo.UseShellExecute = true;
            Process.Start(startInfo);
        }

        private static void RollBack(List<FileChange> changes)
        {
            for (int i = changes.Count - 1; i >= 0; i--)
            {
                FileChange change = changes[i];
                try
                {
                    if (Directory.Exists(change.Destination)) Directory.Delete(change.Destination, true);
                    else if (File.Exists(change.Destination)) File.Delete(change.Destination);
                    if (change.HadBackup)
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(change.Destination));
                        if (change.WasDirectory) Directory.Move(change.Backup, change.Destination);
                        else File.Move(change.Backup, change.Destination);
                    }
                }
                catch { }
            }
        }

        private static int CompareVersions(string left, string right)
        {
            Match a = Regex.Match(left ?? String.Empty, "^(\\d+)\\.(\\d+)\\.(\\d+)");
            Match b = Regex.Match(right ?? String.Empty, "^(\\d+)\\.(\\d+)\\.(\\d+)");
            if (!a.Success || !b.Success) throw new InvalidDataException("バージョン番号を解釈できません。");
            for (int i = 1; i <= 3; i++)
            {
                int av = Int32.Parse(a.Groups[i].Value);
                int bv = Int32.Parse(b.Groups[i].Value);
                if (av != bv) return av.CompareTo(bv);
            }
            return 0;
        }

        private sealed class FileChange
        {
            public string Destination;
            public string Backup;
            public bool HadBackup;
            public bool WasDirectory;
            public FileChange(string destination, string backup, bool hadBackup, bool wasDirectory)
            {
                Destination = destination;
                Backup = backup;
                HadBackup = hadBackup;
                WasDirectory = wasDirectory;
            }
        }
    }
}
