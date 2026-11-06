using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CraftMateSetup
{
    // =================================================================
    // 言語選択ダイアログ
    // =================================================================
    public class LanguageForm : Form
    {
        public string SelectedLanguage = "en";
        public LanguageForm()
        {
            Text = "Select Language";
            Size = new Size(300, 150);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            BackColor = Color.FromArgb(245, 245, 245);

            Label lbl = new Label();
            lbl.Text = "Please select a language:";
            lbl.Location = new Point(20, 20);
            lbl.AutoSize = true;
            Controls.Add(lbl);

            ComboBox combo = new ComboBox();
            combo.Location = new Point(20, 50);
            combo.Width = 240;
            combo.DropDownStyle = ComboBoxStyle.DropDownList;
            combo.Items.Add("English");
            combo.Items.Add("\u65e5\u672c\u8a9e");
            combo.SelectedIndex = 0;
            Controls.Add(combo);

            Button btn = new Button();
            btn.Text = "OK";
            btn.Location = new Point(180, 80);
            btn.DialogResult = DialogResult.OK;
            btn.Click += delegate {
                SelectedLanguage = combo.SelectedIndex == 1 ? "ja" : "en";
                Close();
            };
            Controls.Add(btn);
        }
    }

    // =================================================================
    // メインインストーラー画面
    // =================================================================
    public class InstallerForm : Form
    {
        private string _lang;
        private Label _lblTitle, _lblPath, _lblStatus, _lblUpdate;
        private TextBox _txtPath, _txtLog;
        private Button _btnBrowse, _btnInstall;
        private CheckBox _chkAgree, _chkLaunch;
        private ProgressBar _progressBar;
        private PictureBox _picAppIcon;

        private const string CurrentVersion = "1.3.3";
        private const string GitHubApiUrl = "https://api.github.com/repos/kurageno8156-lgtm/craftmate-payload/releases/latest";
        private const string DownloadUrl = "https://github.com/kurageno8156-lgtm/craftmate-payload/releases/download/v1.3.3/app_payload.zip";

        public InstallerForm(string lang)
        {
            _lang = lang;

            Text = "CraftMate Setup";
            Size = new Size(600, 550);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(245, 245, 245);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;

            // The icon is embedded into the setup executable at build time.
            using (Stream iconStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("CraftMate.app.ico"))
            {
                if (iconStream != null)
                {
                    using (Icon appIcon = new Icon(iconStream))
                    {
                        Icon = (Icon)appIcon.Clone();
                        _picAppIcon = new PictureBox();
                        _picAppIcon.Image = appIcon.ToBitmap();
                    }
                    _picAppIcon.Location = new Point(20, 18);
                    _picAppIcon.Size = new Size(64, 64);
                    _picAppIcon.SizeMode = PictureBoxSizeMode.Zoom;
                    Controls.Add(_picAppIcon);
                }
            }

            // タイトル（エメラルドグリーン）
            _lblTitle = new Label();
            _lblTitle.Text = "CraftMate Setup";
            _lblTitle.Font = new Font("Segoe UI", 18, FontStyle.Bold);
            _lblTitle.ForeColor = Color.FromArgb(16, 185, 129); // 緑
            _lblTitle.Location = new Point(100, 30);
            _lblTitle.AutoSize = true;

            // アップデート通知ラベル
            _lblUpdate = new Label();
            _lblUpdate.Text = "";
            _lblUpdate.ForeColor = Color.Red;
            _lblUpdate.Location = new Point(100, 65);
            _lblUpdate.AutoSize = true;
            _lblUpdate.Visible = false;

            // インストール先
            _lblPath = new Label();
            _lblPath.Text = _lang == "ja" ? "インストール先の親フォルダー:" : "Install Base Folder:";
            _lblPath.Location = new Point(20, 90);
            _lblPath.AutoSize = true;

            _txtPath = new TextBox();
            _txtPath.Location = new Point(20, 115);
            _txtPath.Width = 450;
            _txtPath.Text = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);

            _btnBrowse = new Button();
            _btnBrowse.Text = _lang == "ja" ? "参照..." : "Browse...";
            _btnBrowse.Location = new Point(480, 113);
            _btnBrowse.Width = 80;
            _btnBrowse.Click += delegate {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog()) {
                    if (dlg.ShowDialog() == DialogResult.OK) _txtPath.Text = dlg.SelectedPath;
                }
            };

            // 同意チェックボックス
            _chkAgree = new CheckBox();
            _chkAgree.Text = _lang == "ja" ? "利用規約とプライバシーポリシーに同意します" : "I agree to the Terms and Privacy Policy";
            _chkAgree.Location = new Point(20, 150);
            _chkAgree.AutoSize = true;
            _chkAgree.CheckedChanged += delegate { _btnInstall.Enabled = _chkAgree.Checked; };

            // 利用規約リンク（簡易ダイアログ）
            LinkLabel lnkTerms = new LinkLabel();
            lnkTerms.Text = _lang == "ja" ? "規約を読む" : "Read Terms";
            lnkTerms.Location = new Point(280, 150);
            lnkTerms.AutoSize = true;
            lnkTerms.Click += delegate {
                MessageBox.Show("利用規約:\n本ソフトウェアは自己責任でご利用ください。\n\nプライバシーポリシー:\n個人情報は収集しません。", "Terms & Privacy");
            };

            // 起動チェックボックス
            _chkLaunch = new CheckBox();
            _chkLaunch.Text = _lang == "ja" ? "インストール後にCraftMateを起動する" : "Launch CraftMate after installation";
            _chkLaunch.Location = new Point(20, 180);
            _chkLaunch.AutoSize = true;
            _chkLaunch.Checked = true;

            // インストールボタン（緑）
            _btnInstall = new Button();
            _btnInstall.Text = _lang == "ja" ? "インストール" : "Install";
            _btnInstall.Location = new Point(400, 210);
            _btnInstall.Width = 160;
            _btnInstall.Height = 35;
            _btnInstall.BackColor = Color.FromArgb(16, 185, 129);
            _btnInstall.ForeColor = Color.White;
            _btnInstall.FlatStyle = FlatStyle.Flat;
            _btnInstall.FlatAppearance.BorderSize = 0;
            _btnInstall.Enabled = false; // 同意するまで無効
            _btnInstall.Click += delegate { StartInstall(); };

            // ステータス
            _lblStatus = new Label();
            _lblStatus.Text = _lang == "ja" ? "準備完了" : "Ready";
            _lblStatus.Location = new Point(20, 220);
            _lblStatus.AutoSize = true;
            _lblStatus.ForeColor = Color.Gray;

            // プログレスバー
            _progressBar = new ProgressBar();
            _progressBar.Location = new Point(20, 250);
            _progressBar.Width = 540;
            _progressBar.Height = 20;

            // ログ
            _txtLog = new TextBox();
            _txtLog.Location = new Point(20, 280);
            _txtLog.Width = 540;
            _txtLog.Height = 200;
            _txtLog.Multiline = true;
            _txtLog.ScrollBars = ScrollBars.Vertical;
            _txtLog.ReadOnly = true;
            _txtLog.BackColor = Color.White;
            _txtLog.ForeColor = Color.DimGray;
            _txtLog.Text = ">>> Log output" + Environment.NewLine;

            Controls.Add(_lblTitle);
            Controls.Add(_lblUpdate);
            Controls.Add(_lblPath); Controls.Add(_txtPath); Controls.Add(_btnBrowse);
            Controls.Add(_chkAgree); Controls.Add(lnkTerms);
            Controls.Add(_chkLaunch);
            Controls.Add(_btnInstall);
            Controls.Add(_lblStatus);
            Controls.Add(_progressBar);
            Controls.Add(_txtLog);

            // アップデートチェックを非同期で開始
            ThreadPool.QueueUserWorkItem(delegate { CheckForUpdates(); });
        }

        // アップデート確認
        private void CheckForUpdates()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(GitHubApiUrl);
                req.UserAgent = "CraftMateSetup";
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader reader = new StreamReader(res.GetResponseStream()))
                {
                    string json = reader.ReadToEnd();
                    // 簡易パース（tag_name を探す）
                    int idx = json.IndexOf("\"tag_name\":\"");
                    if (idx >= 0)
                    {
                        int start = idx + 12;
                        int end = json.IndexOf("\"", start);
                        string latestVersion = json.Substring(start, end - start).Replace("v", "");
                        if (latestVersion != CurrentVersion && latestVersion != "")
                        {
                            Invoke(new Action(delegate {
                                _lblUpdate.Text = _lang == "ja" ? "新しいアップデートがあります: v" + latestVersion : "Update available: v" + latestVersion;
                                _lblUpdate.Visible = true;
                            }));
                        }
                    }
                }
            }
            catch { }
        }

        private void StartInstall()
        {
            _btnInstall.Enabled = false;
            _chkAgree.Enabled = false;
            _lblStatus.Text = _lang == "ja" ? "インストール中..." : "Installing...";
            ThreadPool.QueueUserWorkItem(delegate { DoInstall(); });
        }

        private void DoInstall()
        {
            try
            {
                string installRoot = _txtPath.Text.Trim();
                if (string.IsNullOrEmpty(installRoot))
                {
                    throw new InvalidOperationException("Choose an installation base folder.");
                }
                installRoot = Path.GetFullPath(installRoot);
                string folderName = Path.GetFileName(installRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                string target = string.Equals(folderName, "CraftMate", StringComparison.OrdinalIgnoreCase)
                    ? installRoot
                    : Path.Combine(installRoot, "CraftMate");
                Directory.CreateDirectory(target);
                string tempZip = Path.GetTempFileName();

                Invoke(new Action(delegate { _txtLog.AppendText(">>> Downloading...\r\n"); }));

                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(DownloadUrl);
                req.UserAgent = "CraftMateSetup";
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (Stream s = res.GetResponseStream())
                using (FileStream fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write))
                {
                    byte[] buf = new byte[8192];
                    int len;
                    while ((len = s.Read(buf, 0, buf.Length)) > 0) fs.Write(buf, 0, len);
                }

                Invoke(new Action(delegate { _txtLog.AppendText(">>> Extracting...\r\n"); }));

                using (ZipArchive archive = ZipFile.OpenRead(tempZip))
                {
                    int total = archive.Entries.Count;
                    int count = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string dest = Path.Combine(target, entry.FullName);
                        if (!string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            entry.ExtractToFile(dest, true);
                            count++;
                            int pct = (int)((count / (double)total) * 100);
                            Invoke(new Action(delegate {
                                _progressBar.Value = pct;
                                _txtLog.AppendText("  " + entry.Name + "\r\n");
                            }));
                        }
                    }
                }
                File.Delete(tempZip);
                InstallEmbeddedUninstaller(target);

                try
                {
                    string desktopDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    string programsDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                    string startMenuFolder = Path.Combine(programsDirectory, "CraftMate");
                    Directory.CreateDirectory(startMenuFolder);
                    string executable = Path.Combine(target, "CraftMate.exe");
                    CreateShortcut(Path.Combine(desktopDirectory, "CraftMate.lnk"), executable, target);
                    CreateShortcut(Path.Combine(startMenuFolder, "CraftMate.lnk"), executable, target);
                }
                catch (Exception shortcutError)
                {
                    Invoke(new Action(delegate { _txtLog.AppendText("Shortcut creation warning: " + shortcutError.Message + "\r\n"); }));
                }

                // =====================================================
                // Windowsの「インストールされているアプリ」に登録
                // =====================================================
                try
                {
                    string uninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\CraftMate";
                    using (RegistryKey key = Registry.CurrentUser.CreateSubKey(uninstallKey))
                    {
                        if (key == null)
                        {
                            throw new InvalidOperationException("Could not create the CraftMate uninstall registry key.");
                        }

                        string uninstaller = Path.Combine(target, "Uninstall.exe");
                        string iconPath = Path.Combine(target, "public", "app.ico");
                        long sizeBytes = 0;
                        try
                        {
                            foreach (FileInfo file in new DirectoryInfo(target).GetFiles("*", SearchOption.AllDirectories))
                            {
                                sizeBytes += file.Length;
                            }
                        }
                        catch (Exception sizeError)
                        {
                            Invoke(new Action(delegate { _txtLog.AppendText("Size estimate warning: " + sizeError.Message + "\r\n"); }));
                        }

                        int estimatedSizeKb = (int)Math.Min(int.MaxValue, Math.Ceiling(sizeBytes / 1024.0));
                        key.SetValue("DisplayName", "CraftMate - Minecraft AI Agent", RegistryValueKind.String);
                        key.SetValue("DisplayVersion", CurrentVersion, RegistryValueKind.String);
                        key.SetValue("Publisher", "CraftMate Team", RegistryValueKind.String);
                        key.SetValue("InstallLocation", target, RegistryValueKind.String);
                        key.SetValue("UninstallString", "\"" + uninstaller + "\"", RegistryValueKind.String);
                        key.SetValue("DisplayIcon", iconPath, RegistryValueKind.String);
                        key.SetValue("EstimatedSize", estimatedSizeKb, RegistryValueKind.DWord);
                        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);

                        // Stale registrations may have hidden the app from Windows Settings.
                        key.DeleteValue("SystemComponent", false);
                        key.Flush();
                    }
                }
                catch (Exception ex) {
                    // レジストリ登録失敗は致命的ではないので、ログに出すだけ
                    Invoke(new Action(delegate { _txtLog.AppendText("Registry error: " + ex.Message + "\r\n"); }));
                }

                Invoke(new Action(delegate {
                    _lblStatus.Text = _lang == "ja" ? "インストール完了" : "Installation Complete";
                    _progressBar.Value = 100;
                    _txtLog.AppendText(">>> Done.\r\n");

                    if (_chkLaunch.Checked)
                    {
                        string exe = Path.Combine(target, "CraftMate.exe");
                        if (File.Exists(exe)) System.Diagnostics.Process.Start(exe);
                    }
                    MessageBox.Show(_lang == "ja" ? "インストールが完了しました。" : "Installation completed.", "Complete");
                    Application.Exit();
                    Environment.Exit(0);
                }));
            }
            catch (Exception ex)
            {
                Invoke(new Action(delegate { MessageBox.Show("Error: " + ex.Message); }));
            }
            finally
            {
                Invoke(new Action(delegate { _btnInstall.Enabled = true; _chkAgree.Enabled = true; }));
            }
        }

        private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory)
        {
            targetPath = Path.GetFullPath(targetPath);
            workingDirectory = Path.GetFullPath(workingDirectory);
            if (!File.Exists(targetPath))
            {
                throw new FileNotFoundException("CraftMate.exe was not found for the shortcut.", targetPath);
            }
            if (!Directory.Exists(workingDirectory))
            {
                throw new DirectoryNotFoundException("The CraftMate installation folder was not found.");
            }

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                throw new InvalidOperationException("Windows Script Host is unavailable.");
            }

            object shell = Activator.CreateInstance(shellType);
            object shortcut = null;
            try
            {
                shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "CraftMate - Minecraft AI Agent" });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(workingDirectory, "public", "app.ico") + ",0" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.ReleaseComObject(shortcut);
                if (Marshal.IsComObject(shell)) Marshal.ReleaseComObject(shell);
            }
        }

        private static void InstallEmbeddedUninstaller(string targetDirectory)
        {
            using (Stream resource = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("CraftMate.Uninstall.exe"))
            {
                if (resource == null)
                {
                    throw new InvalidOperationException("The uninstaller is missing from the setup package.");
                }

                string uninstallerPath = Path.Combine(targetDirectory, "Uninstall.exe");
                using (FileStream output = new FileStream(uninstallerPath, FileMode.Create, FileAccess.Write))
                {
                    resource.CopyTo(output);
                }
            }
        }
    }

    // =================================================================
    // プログラムのエントリーポイント
    // =================================================================
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string lang = "en";
            using (LanguageForm lf = new LanguageForm())
            {
                if (lf.ShowDialog() == DialogResult.OK)
                {
                    lang = lf.SelectedLanguage;
                }
            }

            Application.Run(new InstallerForm(lang));
        }
    }
}
