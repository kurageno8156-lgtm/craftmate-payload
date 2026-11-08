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
    internal static class InstallerIcon
    {
        public static void Apply(Form form)
        {
            using (Stream iconStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("CraftMate.app.ico"))
            {
                if (iconStream == null) return;
                using (Icon appIcon = new Icon(iconStream))
                {
                    form.Icon = (Icon)appIcon.Clone();
                }
            }
        }

        public static Bitmap CreateBitmap()
        {
            using (Stream iconStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("CraftMate.app.ico"))
            {
                if (iconStream == null) return null;
                using (MemoryStream iconBuffer = new MemoryStream())
                {
                    iconStream.CopyTo(iconBuffer);
                    byte[] iconData = iconBuffer.ToArray();
                    if (iconData.Length < 6 || BitConverter.ToUInt16(iconData, 0) != 0 || BitConverter.ToUInt16(iconData, 2) != 1)
                    {
                        return null;
                    }

                    int imageCount = BitConverter.ToUInt16(iconData, 4);
                    int selectedOffset = -1;
                    int selectedSize = 0;
                    int largestDimension = 0;
                    for (int i = 0; i < imageCount; i++)
                    {
                        int entryOffset = 6 + (i * 16);
                        if (entryOffset + 16 > iconData.Length) break;
                        int width = iconData[entryOffset] == 0 ? 256 : iconData[entryOffset];
                        int height = iconData[entryOffset + 1] == 0 ? 256 : iconData[entryOffset + 1];
                        int dimension = Math.Max(width, height);
                        int imageSize = (int)BitConverter.ToUInt32(iconData, entryOffset + 8);
                        int imageOffset = (int)BitConverter.ToUInt32(iconData, entryOffset + 12);
                        if (imageSize <= 0 || imageOffset < 0 || imageOffset + imageSize > iconData.Length) continue;
                        if (dimension > largestDimension)
                        {
                            largestDimension = dimension;
                            selectedOffset = imageOffset;
                            selectedSize = imageSize;
                        }
                    }

                    if (selectedOffset < 0) return null;
                    byte[] pngSignature = new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };
                    bool isPng = selectedSize >= pngSignature.Length;
                    for (int i = 0; isPng && i < pngSignature.Length; i++)
                    {
                        if (iconData[selectedOffset + i] != pngSignature[i]) isPng = false;
                    }
                    if (!isPng) return null;

                    using (MemoryStream pngStream = new MemoryStream(iconData, selectedOffset, selectedSize))
                    using (Image source = Image.FromStream(pngStream))
                    {
                        Bitmap resized = new Bitmap(64, 64, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                        using (System.Drawing.Graphics graphics = System.Drawing.Graphics.FromImage(resized))
                        {
                            graphics.Clear(Color.Transparent);
                            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                            graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                            graphics.DrawImage(source, new Rectangle(0, 0, 64, 64));
                        }
                        return resized;
                    }
                }
            }
        }
    }

    // =================================================================
    // 言語選択ダイアログ
    // =================================================================
    public class LanguageForm : Form
    {
        private ComboBox _languageList;

        public string SelectedLanguage { get; private set; }

        public LanguageForm()
        {
            SelectedLanguage = "en";

            Text = "\u0043\u0072\u0061\u0066\u0074\u004d\u0061\u0074\u0065 \u0053\u0065\u0074\u0075\u0070 - \u8a00\u8a9e\u9078\u629e";
            Size = new Size(420, 280);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            InstallerIcon.Apply(this);

            var lblInstruction = new Label();
            lblInstruction.Text = "\u8a00\u8a9e\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002";
            lblInstruction.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            lblInstruction.Location = new Point(24, 24);
            lblInstruction.AutoSize = true;
            lblInstruction.Width = 360;

            _languageList = new ComboBox();
            _languageList.DropDownStyle = ComboBoxStyle.DropDownList;
            _languageList.Location = new Point(24, 64);
            _languageList.Width = 360;
            _languageList.Items.Add(new LanguageItem("\u65e5\u672c\u8a9e", "ja"));
            _languageList.Items.Add(new LanguageItem("\u0045\u006e\u0067\u006c\u0069\u0073\u0068", "en"));
            _languageList.Items.Add(new LanguageItem("\ud55c\uad6d\uc5b4", "ko"));
            _languageList.Items.Add(new LanguageItem("\u0045\u0073\u0070\u0061\u00f1\u006f\u006c", "es"));
            _languageList.Items.Add(new LanguageItem("\u0042\u0061\u0068\u0061\u0073\u0061 \u0049\u006e\u0064\u006f\u006e\u0065\u0073\u0069\u0061", "id"));
            _languageList.Items.Add(new LanguageItem("\u4e2d\u6587 (\u7b80\u4f53)", "zh"));
            _languageList.Items.Add(new LanguageItem("\u0939\u093f\u0928\u094d\u0926\u0940", "hi"));
            _languageList.SelectedIndex = 0;

            var btnOk = new Button();
            btnOk.Text = "\u004f\u004b";
            btnOk.Location = new Point(300, 156);
            btnOk.Width = 84;
            btnOk.DialogResult = DialogResult.OK;
            btnOk.Click += delegate
            {
                SelectedLanguage = ((LanguageItem)_languageList.SelectedItem).Code;
                Close();
            };

            AcceptButton = btnOk;

            Controls.Add(lblInstruction);
            Controls.Add(_languageList);
            Controls.Add(btnOk);
        }

        private sealed class LanguageItem
        {
            public string Display { get; private set; }
            public string Code { get; private set; }

            public LanguageItem(string display, string code)
            {
                Display = display;
                Code = code;
            }

            public override string ToString()
            {
                return Display;
            }
        }
    }


    // =================================================================
    // UIテキスト多言語辞書
    // =================================================================
    internal static class UITexts
    {
        private static readonly Dictionary<string, Dictionary<string, string>> _texts =
            new Dictionary<string, Dictionary<string, string>>
            {
                {
                    "ja", new Dictionary<string, string>
                    {
                        { "Header", "\u0043\u0072\u0061\u0066\u0074\u004d\u0061\u0074\u0065\u0020セットアップ" },
                        { "SelectFolder", "インストール先の親フォルダー\u003a" },
                        { "Browse", "参照\u2026" },
                        { "Install", "インストール" },
                        { "LogHeader", "\u003e\u003e\u003e\u0020ログ出力" },
                        { "Downloading", "\u003e\u003e\u003e\u0020ダウンロード中\u2026" },
                        { "Extracting", "\u003e\u003e\u003e\u0020抽出中\u2026" },
                        { "Completed", "インストールが完了しました。" },
                        { "CreatingShortcuts", "\u003e\u003e\u003e\u0020ショートカットを作成中\u2026" },
                        { "ShortcutsCreated", "\u003e\u003e\u003e\u0020ショートカットの作成が完了しました。" }
                    }
                },
                {
                    "en", new Dictionary<string, string>
                    {
                        { "Header", "\u0043\u0072\u0061\u0066\u0074\u004d\u0061\u0074\u0065\u0020\u0053\u0065\u0074\u0075\u0070" },
                        { "SelectFolder", "\u0049\u006e\u0073\u0074\u0061\u006c\u006c\u0020\u0042\u0061\u0073\u0065\u0020\u0046\u006f\u006c\u0064\u0065\u0072\u003a" },
                        { "Browse", "\u0042\u0072\u006f\u0077\u0073\u0065\u002e\u002e\u002e" },
                        { "Install", "\u0049\u006e\u0073\u0074\u0061\u006c\u006c" },
                        { "LogHeader", "\u003e\u003e\u003e\u0020\u004c\u006f\u0067\u0020\u006f\u0075\u0074\u0070\u0075\u0074" },
                        { "Downloading", "\u003e\u003e\u003e\u0020\u0044\u006f\u0077\u006e\u006c\u006f\u0061\u0064\u0069\u006e\u0067\u002e\u002e\u002e" },
                        { "Extracting", "\u003e\u003e\u003e\u0020\u0045\u0078\u0074\u0072\u0061\u0063\u0074\u0069\u006e\u0067\u002e\u002e\u002e" },
                        { "Completed", "\u0049\u006e\u0073\u0074\u0061\u006c\u006c\u0061\u0074\u0069\u006f\u006e\u0020\u0063\u006f\u006d\u0070\u006c\u0065\u0074\u0065\u002e" },
                        { "CreatingShortcuts", "\u003e\u003e\u003e\u0020\u0043\u0072\u0065\u0061\u0074\u0069\u006e\u0067\u0020\u0073\u0068\u006f\u0072\u0074\u0063\u0075\u0074\u0073\u002e\u002e\u002e" },
                        { "ShortcutsCreated", "\u003e\u003e\u003e\u0020\u0053\u0068\u006f\u0072\u0074\u0063\u0075\u0074\u0073\u0020\u0063\u0072\u0065\u0061\u0074\u0065\u0064\u002e" }
                    }
                },
                {
                    "ko", new Dictionary<string, string>
                    {
                        { "Header", "\ud06c\ub798\ud504\ud2b8\uba54\uc774\ud2b8\u0020\uc124\uce58" },
                        { "SelectFolder", "\uc124\uce58\ud560\u0020\uae30\ubcf8\u0020\ud3f4\ub354\u003a" },
                        { "Browse", "\ucc3e\uc544\ubcf4\uae30\u002e\u002e\u002e" },
                        { "Install", "\uc124\uce58" },
                        { "LogHeader", "\u003e\u003e\u003e\u0020\ub85c\uadf8\u0020\ucd9c\ub825" },
                        { "Downloading", "\u003e\u003e\u003e\u0020\ub2e4\uc6b4\ub85c\ub4dc\u0020\uc911\u002e\u002e\u002e" },
                        { "Extracting", "\u003e\u003e\u003e\u0020\uc555\ucd95\u0020\ud574\uc81c\u0020\uc911\u002e\u002e\u002e" },
                        { "Completed", "\uc124\uce58\uac00\u0020\uc644\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4\u002e" },
                        { "CreatingShortcuts", "\u003e\u003e\u003e\u0020\ubc14\ub85c\uac00\uae30\u0020\ub9cc\ub4e4\uae30\u0020\uc911\u002e\u002e\u002e" },
                        { "ShortcutsCreated", "\u003e\u003e\u003e\u0020\ubc14\ub85c\uac00\uae30\u0020\uc0dd\uc131\uc774\u0020\uc644\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4\u002e" }
                    }
                },
                {
                    "es", new Dictionary<string, string>
                    {
                        { "Header", "\u0043\u006f\u006e\u0066\u0069\u0067\u0075\u0072\u0061\u0063\u0069\u00f3\u006e\u0020\u0064\u0065\u0020\u0043\u0072\u0061\u0066\u0074\u004d\u0061\u0074\u0065" },
                        { "SelectFolder", "\u0043\u0061\u0072\u0070\u0065\u0074\u0061\u0020\u0064\u0065\u0020\u0069\u006e\u0073\u0074\u0061\u006c\u0061\u0063\u0069\u00f3\u006e\u0020\u0062\u0061\u0073\u0065\u003a" },
                        { "Browse", "\u0045\u0078\u0061\u006d\u0069\u006e\u0061\u0072\u002e\u002e\u002e" },
                        { "Install", "\u0049\u006e\u0073\u0074\u0061\u006c\u0061\u0072" },
                        { "LogHeader", "\u003e\u003e\u003e\u0020\u0053\u0061\u006c\u0069\u0064\u0061\u0020\u0064\u0065\u006c\u0020\u0072\u0065\u0067\u0069\u0073\u0074\u0072\u006f" },
                        { "Downloading", "\u003e\u003e\u003e\u0020\u0044\u0065\u0073\u0063\u0061\u0072\u0067\u0061\u006e\u0064\u006f\u002e\u002e\u002e" },
                        { "Extracting", "\u003e\u003e\u003e\u0020\u0045\u0078\u0074\u0072\u0061\u0079\u0065\u006e\u0064\u006f\u002e\u002e\u002e" },
                        { "Completed", "\u0049\u006e\u0073\u0074\u0061\u006c\u0061\u0063\u0069\u00f3\u006e\u0020\u0063\u006f\u006d\u0070\u006c\u0065\u0074\u0061\u002e" },
                        { "CreatingShortcuts", "\u003e\u003e\u003e\u0020\u0043\u0072\u0065\u0061\u006e\u0064\u006f\u0020\u0061\u0063\u0063\u0065\u0073\u006f\u0073\u0020\u0064\u0069\u0072\u0065\u0063\u0074\u006f\u0073\u002e\u002e\u002e" },
                        { "ShortcutsCreated", "\u003e\u003e\u003e\u0020\u0041\u0063\u0063\u0065\u0073\u006f\u0073\u0020\u0064\u0069\u0072\u0065\u0063\u0074\u006f\u0073\u0020\u0063\u0072\u0065\u0061\u0064\u006f\u0073\u002e" }
                    }
                },
                {
                    "id", new Dictionary<string, string>
                    {
                        { "Header", "\u0050\u0065\u006e\u0067\u0061\u0074\u0075\u0072\u0061\u006e\u0020\u0043\u0072\u0061\u0066\u0074\u004d\u0061\u0074\u0065" },
                        { "SelectFolder", "\u0046\u006f\u006c\u0064\u0065\u0072\u0020\u0069\u006e\u0073\u0074\u0061\u006c\u0061\u0073\u0069\u0020\u0064\u0061\u0073\u0061\u0072\u003a" },
                        { "Browse", "\u0054\u0065\u006c\u0075\u0073\u0075\u0072\u0069\u002e\u002e\u002e" },
                        { "Install", "\u0049\u006e\u0073\u0074\u0061\u006c" },
                        { "LogHeader", "\u003e\u003e\u003e\u0020\u004b\u0065\u006c\u0075\u0061\u0072\u0061\u006e\u0020\u006c\u006f\u0067" },
                        { "Downloading", "\u003e\u003e\u003e\u0020\u004d\u0065\u006e\u0067\u0075\u006e\u0064\u0075\u0068\u002e\u002e\u002e" },
                        { "Extracting", "\u003e\u003e\u003e\u0020\u004d\u0065\u006e\u0067\u0065\u006b\u0073\u0074\u0072\u0061\u006b\u002e\u002e\u002e" },
                        { "Completed", "\u0049\u006e\u0073\u0074\u0061\u006c\u0061\u0073\u0069\u0020\u0073\u0065\u006c\u0065\u0073\u0061\u0069\u002e" },
                        { "CreatingShortcuts", "\u003e\u003e\u003e\u0020\u004d\u0065\u006d\u0062\u0075\u0061\u0074\u0020\u0070\u0069\u006e\u0074\u0061\u0073\u0061\u006e\u002e\u002e\u002e" },
                        { "ShortcutsCreated", "\u003e\u003e\u003e\u0020\u0050\u0069\u006e\u0074\u0061\u0073\u0061\u006e\u0020\u0074\u0065\u006c\u0061\u0068\u0020\u0064\u0069\u0062\u0075\u0061\u0074\u002e" }
                    }
                },
                {
                    "zh", new Dictionary<string, string>
                    {
                        { "Header", "\u0043\u0072\u0061\u0066\u0074\u004d\u0061\u0074\u0065\u0020\u8bbe\u7f6e" },
                        { "SelectFolder", "\u5b89\u88c5\u57fa\u6587\u4ef6\u5939\u003a" },
                        { "Browse", "\u6d4f\u89c8\u002e\u002e\u002e" },
                        { "Install", "\u5b89\u88c5" },
                        { "LogHeader", "\u003e\u003e\u003e\u0020\u65e5\u5fd7\u8f93\u51fa" },
                        { "Downloading", "\u003e\u003e\u003e\u0020\u6b63\u5728\u4e0b\u8f7d\u002e\u002e\u002e" },
                        { "Extracting", "\u003e\u003e\u003e\u0020\u6b63\u5728\u89e3\u538b\u002e\u002e\u002e" },
                        { "Completed", "\u5b89\u88c5\u5b8c\u6210\u3002" },
                        { "CreatingShortcuts", "\u003e\u003e\u003e\u0020\u6b63\u5728\u521b\u5efa\u5feb\u6377\u65b9\u5f0f\u002e\u002e\u002e" },
                        { "ShortcutsCreated", "\u003e\u003e\u003e\u0020\u5feb\u6377\u65b9\u5f0f\u5df2\u521b\u5efa\u3002" }
                    }
                },
                {
                    "hi", new Dictionary<string, string>
                    {
                        { "Header", "\u0915\u094d\u0930\u093e\u092b\u094d\u091f\u092e\u0947\u091f\u0020\u0938\u0947\u091f\u0905\u092a" },
                        { "SelectFolder", "\u0907\u0902\u0938\u094d\u091f\u0949\u0932\u0020\u092c\u0947\u0938\u0020\u092b\u094b\u0932\u094d\u0921\u0930\u003a" },
                        { "Browse", "\u092c\u094d\u0930\u093e\u0909\u091c\u093c\u0020\u0915\u0930\u0947\u0902\u002e\u002e\u002e" },
                        { "Install", "\u0907\u0902\u0938\u094d\u091f\u0949\u0932\u0020\u0915\u0930\u0947\u0902" },
                        { "LogHeader", "\u003e\u003e\u003e\u0020\u0932\u0949\u0917\u0020\u0906\u0909\u091f\u092a\u0941\u091f" },
                        { "Downloading", "\u003e\u003e\u003e\u0020\u0921\u093e\u0909\u0928\u0932\u094b\u0921\u0020\u0939\u094b\u0020\u0930\u0939\u093e\u0020\u0939\u0948\u002e\u002e\u002e" },
                        { "Extracting", "\u003e\u003e\u003e\u0020\u0928\u093f\u0915\u093e\u0932\u0020\u0930\u0939\u093e\u0020\u0939\u0948\u002e\u002e\u002e" },
                        { "Completed", "\u0907\u0902\u0938\u094d\u091f\u0949\u0932\u0947\u0936\u0928\u0020\u092a\u0942\u0930\u093e\u0020\u0939\u094b\u0020\u0917\u092f\u093e\u0964" },
                        { "CreatingShortcuts", "\u003e\u003e\u003e\u0020\u0936\u0949\u0930\u094d\u091f\u0915\u091f\u0020\u092c\u0928\u093e\u090f\u0020\u091c\u093e\u0020\u0930\u0939\u0947\u0020\u0939\u0948\u0902\u002e\u002e\u002e" },
                        { "ShortcutsCreated", "\u003e\u003e\u003e\u0020\u0936\u0949\u0930\u094d\u091f\u0915\u091f\u0020\u092c\u0928\u0020\u0917\u090f\u0020\u0939\u0948\u0902\u0964" }
                    }
                }
            };

        public static string Get(string lang, string key)
        {
            if (string.IsNullOrEmpty(lang)) lang = "en";
            Dictionary<string, string> dict = _texts["en"];
            _texts.TryGetValue(lang, out dict);
            string text = key;
            dict.TryGetValue(key, out text);
            return text;
        }
    }

    // =================================================================
    // 利用規約・プライバシーポリシー
    // =================================================================
    public class TermsForm : Form
    {
        public TermsForm(string lang)
        {
            Text = lang == "ja" ? "利用規約とプライバシーポリシー" : "Terms and Privacy Policy";
            Size = new Size(560, 480);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.FromArgb(245, 245, 245);
            ShowInTaskbar = true;
            InstallerIcon.Apply(this);

            Label heading = new Label();
            heading.Text = lang == "ja" ? "利用規約・プライバシーポリシー" : "Terms of Use and Privacy Policy";
            heading.Font = new Font("Segoe UI", 14, FontStyle.Bold);
            heading.Location = new Point(20, 16);
            heading.AutoSize = true;

            TextBox policy = new TextBox();
            policy.Location = new Point(20, 55);
            policy.Size = new Size(500, 285);
            policy.Multiline = true;
            policy.ReadOnly = true;
            policy.ScrollBars = ScrollBars.Vertical;
            policy.WordWrap = true;
            policy.BackColor = Color.White;
            policy.Text = lang == "ja"
                ? "【利用規約】\r\nCraftMateはMinecraftの操作を支援するソフトウェアです。本ソフトウェアは現状有姿で提供され、利用者は自身の責任で使用するものとします。ゲーム、アカウント、サーバーの利用規約を守り、他の利用者に迷惑をかけないでください。作者は、本ソフトウェアの利用または利用不能によって生じた損害について、法令で認められる範囲で責任を負いません。\r\n\r\n【プライバシーポリシー】\r\n本インストーラーは、インストールのために必要なファイルをGitHubからダウンロードします。アプリは、利用者が設定したAIサービスの接続先にプロンプトやゲーム状態を送信する場合があります。送信される情報の取扱いは、利用するサービスのポリシーに従います。開発者が独自に個人情報を収集・販売することを目的とした機能はありません。APIキーなどの秘密情報を共有しないでください。"
                : "TERMS OF USE\r\nCraftMate is software that assists with Minecraft gameplay. It is provided as is, and you use it at your own risk. Follow the terms of the game, your account, and each server, and do not disrupt other players. To the extent permitted by law, the authors are not liable for damage arising from use or inability to use this software.\r\n\r\nPRIVACY POLICY\r\nThis installer downloads required files from GitHub. The application may send prompts and game state to the AI service you configure. Handling of that information is governed by the service provider's policies. The developers do not intend to collect or sell personal information through a dedicated feature. Do not share API keys or other secrets. ";

            CheckBox agree = new CheckBox();
            agree.Text = lang == "ja" ? "利用規約とプライバシーポリシーに同意する" : "I agree to the Terms and Privacy Policy";
            agree.Location = new Point(20, 352);
            agree.AutoSize = true;

            Button next = new Button();
            next.Text = lang == "ja" ? "次へ" : "Next";
            next.Location = new Point(420, 395);
            next.Size = new Size(100, 32);
            next.Enabled = false;
            next.DialogResult = DialogResult.OK;
            agree.CheckedChanged += delegate { next.Enabled = agree.Checked; };
            next.Click += delegate {
                DialogResult = System.Windows.Forms.DialogResult.OK;
                Close();
            };

            Controls.Add(heading);
            Controls.Add(policy);
            Controls.Add(agree);
            Controls.Add(next);
            AcceptButton = next;
        }
    }

    // =================================================================
    // メインインストーラー画面
    // =================================================================
    public class InstallerForm : Form
    {
        private string _lang;
        private Label _lblTitle, _lblPath, _lblStatus, _lblUpdate, _lblRecommendation;
        private TextBox _txtPath, _txtLog;
        private Button _btnBrowse, _btnInstall;
        private CheckBox _chkLaunch;
        private ProgressBar _progressBar;
        private PictureBox _picAppIcon;

        private const string CurrentVersion = "1.3.71";
        private const string GitHubApiUrl = "https://api.github.com/repos/kurageno8156-lgtm/craftmate-payload/releases/latest";
        private const string DownloadUrl = "https://github.com/kurageno8156-lgtm/craftmate-payload/releases/download/v1.3.71/app_payload.zip";

        public InstallerForm(string lang)
        {
            _lang = lang;

            Text = UITexts.Get(_lang, "Header");
            Size = new Size(600, 550);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(245, 245, 245);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            ShowInTaskbar = true;
            InstallerIcon.Apply(this);

            _picAppIcon = new PictureBox();
            _picAppIcon.Image = InstallerIcon.CreateBitmap();
            if (_picAppIcon.Image != null)
            {
                _picAppIcon.Location = new Point(20, 18);
                _picAppIcon.Size = new Size(64, 64);
                _picAppIcon.SizeMode = PictureBoxSizeMode.Zoom;
                Controls.Add(_picAppIcon);
            }

            // タイトル（エメラルドグリーン）
            _lblTitle = new Label();
            _lblTitle.Text = UITexts.Get(_lang, "Header");
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
            _lblPath.Text = UITexts.Get(_lang, "SelectFolder");
            _lblPath.Location = new Point(20, 90);
            _lblPath.AutoSize = true;

            _txtPath = new TextBox();
            _txtPath.Location = new Point(20, 115);
            _txtPath.Width = 450;
            _txtPath.Text = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "CraftMate");

            _btnBrowse = new Button();
            _btnBrowse.Text = UITexts.Get(_lang, "Browse");
            _btnBrowse.Location = new Point(480, 113);
            _btnBrowse.Width = 80;
            _btnBrowse.Click += delegate {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog()) {
                    if (dlg.ShowDialog() == DialogResult.OK) _txtPath.Text = dlg.SelectedPath;
                }
            };

            _lblRecommendation = new Label();
            _lblRecommendation.Text = _lang == "ja"
                ? "推奨: 書き込み可能なユーザーフォルダにインストールしてください"
                : "Recommended: Install in a user-writable folder.";
            _lblRecommendation.Location = new Point(20, 145);
            _lblRecommendation.AutoSize = true;
            _lblRecommendation.ForeColor = Color.DarkSlateGray;

            // 起動チェックボックス
            _chkLaunch = new CheckBox();
            _chkLaunch.Text = _lang == "ja" ? "インストール後にCraftMateを起動する" : "Launch CraftMate after installation";
            _chkLaunch.Location = new Point(20, 170);
            _chkLaunch.AutoSize = true;
            _chkLaunch.Checked = true;

            // インストールボタン（緑）
            _btnInstall = new Button();
            _btnInstall.Text = UITexts.Get(_lang, "Install");
            _btnInstall.Location = new Point(400, 210);
            _btnInstall.Width = 160;
            _btnInstall.Height = 35;
            _btnInstall.BackColor = Color.FromArgb(16, 185, 129);
            _btnInstall.ForeColor = Color.White;
            _btnInstall.FlatStyle = FlatStyle.Flat;
            _btnInstall.FlatAppearance.BorderSize = 0;
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
            _txtLog.Text = UITexts.Get(_lang, "LogHeader") + Environment.NewLine;

            Controls.Add(_lblTitle);
            Controls.Add(_lblUpdate);
            Controls.Add(_lblPath); Controls.Add(_txtPath); Controls.Add(_btnBrowse);
            Controls.Add(_lblRecommendation);
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

                Invoke(new Action(delegate { _txtLog.AppendText(UITexts.Get(_lang, "Downloading") + "\r\n"); }));

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

                Invoke(new Action(delegate { _txtLog.AppendText(UITexts.Get(_lang, "Extracting") + "\r\n"); }));

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
                string updaterExecutable = Path.Combine(target, "CraftMate_Updater.exe");
                if (!File.Exists(updaterExecutable))
                {
                    throw new FileNotFoundException("The updater was not included in the installation package.", updaterExecutable);
                }

                try
                {
                    string desktopDirectory = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    string programsDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                    string startMenuFolder = Path.Combine(programsDirectory, "CraftMate");
                    Directory.CreateDirectory(startMenuFolder);
                    string executable = Path.Combine(target, "CraftMate.exe");

                    Invoke(new Action(delegate { _txtLog.AppendText(UITexts.Get(_lang, "CreatingShortcuts") + "\r\n"); }));

                    CreateShortcut(Path.Combine(desktopDirectory, "CraftMate.lnk"), executable, target);
                    CreateShortcut(Path.Combine(startMenuFolder, "CraftMate.lnk"), executable, target);
                    CreateShortcut(Path.Combine(startMenuFolder, "CraftMate Updater.lnk"), updaterExecutable, target);
                    string screenViewerExecutable = Path.Combine(target, "CraftMate_ScreenViewer.exe");
                    if (File.Exists(screenViewerExecutable))
                    {
                        CreateShortcut(Path.Combine(startMenuFolder, "CraftMate 画面共有ビューア.lnk"), screenViewerExecutable, target);
                    }

                    Invoke(new Action(delegate { _txtLog.AppendText(UITexts.Get(_lang, "ShortcutsCreated") + "\r\n"); }));
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

                bool launchAfterInstall = false;
                Invoke(new Action(delegate {
                    _lblStatus.Text = _lang == "ja" ? "インストール完了" : "Installation Complete";
                    _progressBar.Value = 100;
                    _txtLog.AppendText(">>> " + UITexts.Get(_lang, "Completed") + "\r\n");

                    if (_chkLaunch.Checked)
                    {
                        DialogResult answer = MessageBox.Show(
                            this,
                            "CraftMateのインストールが完了しました。OKを押すとアプリを起動します。",
                            "CraftMate",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information);
                        launchAfterInstall = answer == DialogResult.OK;
                    }
                    else
                    {
                        MessageBox.Show(
                            UITexts.Get(_lang, "Completed"),
                            "CraftMate",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information);
                    }
                }));

                if (launchAfterInstall)
                {
                    Invoke(new Action(delegate { _txtLog.AppendText(">>> Starting local dashboard server...\r\n"); }));
                    StartInstalledDashboard(target);
                    Invoke(new Action(delegate { _txtLog.AppendText(">>> Dashboard opened.\r\n"); }));
                }

                Invoke(new Action(delegate { Application.Exit(); }));
                Environment.Exit(0);
            }
            catch (Exception ex)
            {
                Invoke(new Action(delegate { MessageBox.Show("Error: " + ex.Message); }));
            }
            finally
            {
                Invoke(new Action(delegate { _btnInstall.Enabled = true; }));
            }
        }

        private static void StartInstalledDashboard(string targetDirectory)
        {
            string nodePath = Path.Combine(targetDirectory, "node.exe");
            string entryPoint = Path.Combine(targetDirectory, "dist", "index.js");
            string launcherPath = Path.Combine(targetDirectory, "CraftMate.exe");
            if (!File.Exists(nodePath) || !File.Exists(entryPoint) || !File.Exists(launcherPath))
            {
                throw new FileNotFoundException("The installed dashboard runtime is incomplete.");
            }

            if (!IsDashboardReady())
            {
                System.Diagnostics.ProcessStartInfo serverInfo = new System.Diagnostics.ProcessStartInfo();
                serverInfo.FileName = nodePath;
                serverInfo.Arguments = "\"dist\\index.js\"";
                serverInfo.WorkingDirectory = targetDirectory;
                serverInfo.UseShellExecute = false;
                serverInfo.CreateNoWindow = true;
                serverInfo.WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden;
                using (System.Diagnostics.Process serverProcess = System.Diagnostics.Process.Start(serverInfo))
                {
                    if (serverProcess == null)
                    {
                        throw new InvalidOperationException("Could not start the local dashboard server.");
                    }
                }
            }

            bool ready = false;
            for (int attempt = 0; attempt < 24; attempt++)
            {
                if (IsDashboardReady())
                {
                    ready = true;
                    break;
                }
                Thread.Sleep(500);
            }

            if (!ready)
            {
                throw new InvalidOperationException("The dashboard server did not become ready within 12 seconds.");
            }

            System.Diagnostics.ProcessStartInfo launcherInfo = new System.Diagnostics.ProcessStartInfo(launcherPath);
            launcherInfo.WorkingDirectory = targetDirectory;
            launcherInfo.UseShellExecute = true;
            System.Diagnostics.Process.Start(launcherInfo);
        }

        private static bool IsDashboardReady()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://localhost:3000/api/status");
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

            Application.Run(new InstallerApplicationContext());
        }
    }

    internal sealed class InstallerApplicationContext : ApplicationContext
    {
        private string _language = "en";

        public InstallerApplicationContext()
        {
            ShowLanguageForm();
        }

        private void ShowLanguageForm()
        {
            LanguageForm form = new LanguageForm();
            form.FormClosed += delegate
            {
                DialogResult result = form.DialogResult;
                if (result == DialogResult.OK)
                {
                    _language = form.SelectedLanguage;
                }
                form.Dispose();

                if (result == DialogResult.OK)
                {
                    ShowTermsForm();
                }
                else
                {
                    ExitThread();
                }
            };
            form.Show();
        }

        private void ShowTermsForm()
        {
            TermsForm form = new TermsForm(_language);
            form.FormClosed += delegate
            {
                DialogResult result = form.DialogResult;
                form.Dispose();

                if (result == DialogResult.OK)
                {
                    ShowInstallerForm();
                }
                else
                {
                    ExitThread();
                }
            };
            form.Show();
        }

        private void ShowInstallerForm()
        {
            InstallerForm form = new InstallerForm(_language);
            MainForm = form;
            form.Show();
        }
    }
}
