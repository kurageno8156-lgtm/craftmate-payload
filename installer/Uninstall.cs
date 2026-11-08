using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CraftMateUninstall
{
    public class UninstallForm : Form
    {
        private const string RegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CraftMate";
        private Label _statusLabel;
        private TextBox _logTextBox;
        private ProgressBar _progressBar;
        private Button _actionButton;
        private string _installLocation;
        private int _parentProcessId;

        public UninstallForm()
        {
            ConfigureWindow();
            _statusLabel = new Label();
            _statusLabel.Text = "Uninstall CraftMate and remove its installed files?";
            _statusLabel.Location = new System.Drawing.Point(18, 20);
            _statusLabel.Size = new System.Drawing.Size(500, 45);
            Controls.Add(_statusLabel);

            _actionButton = new Button();
            _actionButton.Text = "Uninstall";
            _actionButton.Location = new System.Drawing.Point(325, 82);
            _actionButton.Size = new System.Drawing.Size(95, 30);
            _actionButton.Click += new EventHandler(UninstallButton_Click);
            Controls.Add(_actionButton);

            Button cancelButton = new Button();
            cancelButton.Text = "Cancel";
            cancelButton.Location = new System.Drawing.Point(430, 82);
            cancelButton.Size = new System.Drawing.Size(90, 30);
            cancelButton.DialogResult = DialogResult.Cancel;
            Controls.Add(cancelButton);
            AcceptButton = _actionButton;
            CancelButton = cancelButton;
        }

        public UninstallForm(string installLocation, int parentProcessId)
        {
            ConfigureWindow();
            _installLocation = installLocation;
            _parentProcessId = parentProcessId;
            Text = "CraftMate Uninstall";
            Size = new System.Drawing.Size(590, 410);

            _statusLabel = new Label();
            _statusLabel.Text = "アンインストールを準備しています...";
            _statusLabel.Location = new System.Drawing.Point(14, 12);
            _statusLabel.Size = new System.Drawing.Size(545, 24);
            Controls.Add(_statusLabel);

            _logTextBox = new TextBox();
            _logTextBox.Location = new System.Drawing.Point(14, 42);
            _logTextBox.Size = new System.Drawing.Size(545, 270);
            _logTextBox.Multiline = true;
            _logTextBox.ReadOnly = true;
            _logTextBox.MaxLength = int.MaxValue;
            _logTextBox.ScrollBars = ScrollBars.Vertical;
            _logTextBox.WordWrap = false;
            _logTextBox.Font = new System.Drawing.Font("Consolas", 9);
            Controls.Add(_logTextBox);

            _progressBar = new ProgressBar();
            _progressBar.Location = new System.Drawing.Point(14, 320);
            _progressBar.Size = new System.Drawing.Size(545, 20);
            _progressBar.Minimum = 0;
            _progressBar.Maximum = 1;
            Controls.Add(_progressBar);

            _actionButton = new Button();
            _actionButton.Text = "閉じる";
            _actionButton.Location = new System.Drawing.Point(464, 350);
            _actionButton.Size = new System.Drawing.Size(95, 28);
            _actionButton.Visible = false;
            _actionButton.Click += delegate { Close(); };
            Controls.Add(_actionButton);

            Shown += new EventHandler(ProgressWindow_Shown);
        }

        private void ConfigureWindow()
        {
            Text = "CraftMate Uninstall";
            try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            Size = new System.Drawing.Size(550, 155);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
        }

        private void UninstallButton_Click(object sender, EventArgs e)
        {
            _actionButton.Enabled = false;
            try
            {
                string installLocation;
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryPath, false))
                {
                    installLocation = key == null ? null : key.GetValue("InstallLocation") as string;
                }

                installLocation = ValidateInstallLocation(installLocation);
                DialogResult answer = MessageBox.Show(
                    "Remove CraftMate and all files in this folder?" + Environment.NewLine + installLocation,
                    "Uninstall CraftMate", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (answer != DialogResult.Yes)
                {
                    _actionButton.Enabled = true;
                    return;
                }

                string helperPath = Path.Combine(Path.GetTempPath(), "CraftMateUninstall_" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(Application.ExecutablePath, helperPath, false);
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = helperPath;
                startInfo.Arguments = "--progress " + QuoteArgument(installLocation) + " " + Process.GetCurrentProcess().Id;
                startInfo.CreateNoWindow = true;
                startInfo.UseShellExecute = false;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process helper = Process.Start(startInfo))
                {
                    if (helper == null) throw new InvalidOperationException("Could not start the uninstaller window.");
                }
                Close();
            }
            catch (Exception ex)
            {
                _actionButton.Enabled = true;
                MessageBox.Show("Uninstall could not start: " + ex.Message, "CraftMate Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void ProgressWindow_Shown(object sender, EventArgs e)
        {
            RunUninstall();
        }

        private void RunUninstall()
        {
            try
            {
                WaitForParentProcess(_parentProcessId);
                SetStatus("関連プロセスを終了しています...");
                StopApplicationProcesses();
                AppendLog("プロセス終了後、3秒待機しています...");
                WaitWithUi(3000);
                AppendLog("インストール先: " + _installLocation);

                List<string> files = new List<string>();
                if (Directory.Exists(_installLocation)) CollectFiles(_installLocation, files);

                BackupUserData(_installLocation);

                int total = files.Count + (Directory.Exists(_installLocation) ? 1 : 0);
                SetProgressRange(Math.Max(1, total));
                int completed = 0;
                List<string> failures = new List<string>();

                foreach (string file in files)
                {
                    try
                    {
                        DeleteFileWithRetry(file);
                        AppendLog("削除: " + file);
                    }
                    catch (Exception ex)
                    {
                        failures.Add(file);
                        AppendLog("削除できませんでした（使用中）: " + file);
                        AppendLog("  詳細: " + ex.Message);
                    }
                    AdvanceProgress(++completed);
                    Application.DoEvents();
                }

                if (Directory.Exists(_installLocation))
                {
                    try
                    {
                        AppendLog("削除: " + _installLocation);
                        FlushUi();
                        Directory.Delete(_installLocation, true);
                        if (Directory.Exists(_installLocation)) throw new IOException("フォルダーが残っています。");
                    }
                    catch (Exception ex)
                    {
                        failures.Add(_installLocation);
                        AppendLog("フォルダーを削除できませんでした: " + _installLocation + " (" + ex.Message + ")");
                    }
                    AdvanceProgress(++completed);
                    Application.DoEvents();
                }

                RemoveShortcuts();
                using (RegistryKey uninstallKey = Registry.CurrentUser.OpenSubKey(RegistryPath, true))
                {
                    if (uninstallKey != null) Registry.CurrentUser.DeleteSubKeyTree(RegistryPath, false);
                }

                AppendLog("アンインストールが完了しました");
                if (failures.Count > 0)
                {
                    AppendLog("一部のファイルは手動で削除してください");
                    SetStatus("一部のファイルは手動で削除してください");
                    FlushUi();
                    MessageBox.Show("アンインストールが完了しました。一部のファイルは手動で削除してください。", "CraftMate Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                else
                {
                    SetStatus("アンインストールが完了しました");
                    FlushUi();
                    MessageBox.Show("アンインストールが完了しました", "CraftMate Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                Close();
            }
            catch (Exception ex)
            {
                AppendLog("エラー: " + ex.Message);
                SetStatus("アンインストールに失敗しました。ログを確認してください。");
                ShowCloseButton();
            }
        }

        private void StopApplicationProcesses()
        {
            string[] processNames = new string[] { "CraftMate", "CraftMate_ScreenViewer", "node", "CraftMate_Setup" };
            foreach (string processName in processNames)
            {
                Process[] processes;
                try
                {
                    processes = Process.GetProcessesByName(processName);
                }
                catch (Exception ex)
                {
                    AppendLog("プロセスを検索できませんでした: " + processName + " (" + ex.Message + ")");
                    continue;
                }

                foreach (Process process in processes)
                {
                    try
                    {
                        process.Kill();
                        DateTime exitDeadline = DateTime.UtcNow.AddSeconds(5);
                        while (!process.HasExited && DateTime.UtcNow < exitDeadline)
                        {
                            Application.DoEvents();
                            process.WaitForExit(100);
                        }
                        AppendLog("プロセスを終了: " + processName + " (" + process.Id + ")");
                    }
                    catch (Exception ex)
                    {
                        AppendLog("プロセスを終了できませんでした: " + processName + " (" + ex.Message + ")");
                    }
                    finally
                    {
                        process.Dispose();
                    }
                }
            }
        }

        internal static string ValidateInstallLocation(string installLocation)
        {
            if (string.IsNullOrWhiteSpace(installLocation))
            {
                throw new InvalidOperationException("レジストリからInstallLocationを読み取れません。");
            }

            string fullPath = Path.GetFullPath(installLocation.Trim());
            string folderName = Path.GetFileName(fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            if (!string.Equals(folderName, "CraftMate", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("登録されたインストール先がCraftMateフォルダーではありません。");
            }
            if (Directory.Exists(fullPath) && (File.GetAttributes(fullPath) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("インストール先がリンクされたフォルダーのため、安全のため中止しました。");
            }
            return fullPath;
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void WaitForParentProcess(int processId)
        {
            try
            {
                using (Process parent = Process.GetProcessById(processId)) parent.WaitForExit();
            }
            catch (ArgumentException)
            {
                // The original uninstaller has already exited.
            }
        }

        private static void CollectFiles(string root, List<string> files)
        {
            Stack<string> pending = new Stack<string>();
            pending.Push(root);
            while (pending.Count > 0)
            {
                string current = pending.Pop();
                foreach (string entry in Directory.GetFileSystemEntries(current))
                {
                    FileAttributes attributes = File.GetAttributes(entry);
                    if ((attributes & FileAttributes.Directory) != 0)
                    {
                        // シンボリックリンク/ジャンクションは辿らず、再帰削除時にリンク自体だけを消す
                        if ((attributes & FileAttributes.ReparsePoint) == 0) pending.Push(entry);
                    }
                    else
                    {
                        files.Add(entry);
                    }
                }
            }
        }

        private void BackupUserData(string installLocation)
        {
            try
            {
                string envPath = Path.Combine(installLocation, ".env");
                if (!File.Exists(envPath)) return;

                string backupRoot = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "CraftMate", "uninstall-backup");
                Directory.CreateDirectory(backupRoot);
                string backupPath = Path.Combine(backupRoot, ".env");
                File.Copy(envPath, backupPath, true);
                AppendLog("ユーザーデータをバックアップしました: " + backupPath);
            }
            catch (Exception ex)
            {
                AppendLog("バックアップに失敗しました: " + ex.Message);
            }
        }

        private void DeleteFileWithRetry(string path)
        {
            Exception lastError = null;
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    ClearReadOnlyAttributes(path);
                    File.Delete(path);
                    if (!File.Exists(path)) return;
                    throw new IOException("ファイルが残っています。");
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    WaitWithUi(250 * (attempt + 1));
                }
            }
            throw new IOException("ファイルを削除できませんでした。", lastError);
        }

        private void WaitWithUi(int milliseconds)
        {
            DateTime end = DateTime.UtcNow.AddMilliseconds(milliseconds);
            while (DateTime.UtcNow < end)
            {
                Application.DoEvents();
                int remaining = (int)Math.Max(1, (end - DateTime.UtcNow).TotalMilliseconds);
                Thread.Sleep(Math.Min(50, remaining));
            }
        }

        private static void ClearReadOnlyAttributes(string path)
        {
            FileAttributes attributes = File.GetAttributes(path);
            attributes &= ~(FileAttributes.ReadOnly | FileAttributes.Hidden | FileAttributes.System);
            File.SetAttributes(path, attributes);
        }

        private static void RemoveShortcuts()
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string startMenuFolder = Path.Combine(programs, "CraftMate");
            DeleteShortcut(Path.Combine(desktop, "CraftMate.lnk"));
            DeleteShortcut(Path.Combine(programs, "CraftMate.lnk"));
            DeleteShortcut(Path.Combine(startMenuFolder, "CraftMate.lnk"));
            DeleteShortcut(Path.Combine(startMenuFolder, "CraftMate Updater.lnk"));
            DeleteShortcut(Path.Combine(startMenuFolder, "CraftMate 画面共有ビューア.lnk"));
            if (Directory.Exists(startMenuFolder) && Directory.GetFileSystemEntries(startMenuFolder).Length == 0)
            {
                Directory.Delete(startMenuFolder, false);
            }
        }

        private static void DeleteShortcut(string path)
        {
            if (!File.Exists(path)) return;
            ClearReadOnlyAttributes(path);
            File.Delete(path);
        }

        private void AppendLog(string message)
        {
            if (IsDisposed || !IsHandleCreated) return;
            _logTextBox.AppendText(message + Environment.NewLine);
            _logTextBox.SelectionStart = _logTextBox.TextLength;
            _logTextBox.ScrollToCaret();
        }

        private void FlushUi()
        {
            if (IsDisposed || !IsHandleCreated) return;
            _logTextBox.Refresh();
            _progressBar.Refresh();
            _statusLabel.Refresh();
            Application.DoEvents();
        }

        private void SetProgressRange(int maximum)
        {
            if (IsDisposed || !IsHandleCreated) return;
            _progressBar.Maximum = Math.Max(1, maximum);
            _progressBar.Value = 0;
        }

        private void AdvanceProgress(int value)
        {
            if (IsDisposed || !IsHandleCreated) return;
            _progressBar.Value = Math.Min(value, _progressBar.Maximum);
        }

        private void SetStatus(string text)
        {
            if (IsDisposed || !IsHandleCreated) return;
            _statusLabel.Text = text;
        }

        private void ShowCloseButton()
        {
            if (IsDisposed || !IsHandleCreated) return;
            BeginInvoke(new MethodInvoker(delegate { _actionButton.Visible = true; }));
        }

        private void ScheduleClose()
        {
            ScheduleClose(1800);
        }

        private void ScheduleClose(int interval)
        {
            if (IsDisposed || !IsHandleCreated) return;
            BeginInvoke(new MethodInvoker(delegate
            {
                System.Windows.Forms.Timer closeTimer = new System.Windows.Forms.Timer();
                closeTimer.Interval = interval;
                closeTimer.Tick += delegate
                {
                    closeTimer.Stop();
                    closeTimer.Dispose();
                    Close();
                };
                closeTimer.Start();
            }));
        }

        internal static void ScheduleSelfDelete(string executablePath)
        {
            try
            {
                string command = "ping 127.0.0.1 -n 3 > nul & del /f /q \"" + executablePath + "\" > nul 2>&1";
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
                startInfo.Arguments = "/d /c " + command;
                startInfo.CreateNoWindow = true;
                startInfo.UseShellExecute = false;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(startInfo);
            }
            catch { }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Length == 3 && args[0] == "--progress")
            {
                int parentProcessId;
                try
                {
                    string installLocation = UninstallForm.ValidateInstallLocation(args[1]);
                    if (!int.TryParse(args[2], out parentProcessId)) return;
                    string helperPath = Application.ExecutablePath;
                    Application.Run(new UninstallForm(installLocation, parentProcessId));
                    UninstallForm.ScheduleSelfDelete(helperPath);
                    return;
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Uninstall could not start: " + ex.Message, "CraftMate Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
            }

            Application.Run(new UninstallForm());
        }
    }
}
