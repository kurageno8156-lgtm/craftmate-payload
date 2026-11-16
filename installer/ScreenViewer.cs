using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CraftMateScreenViewer
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // --port N で接続先ポートを変更（既定: 3000）
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--port")
                {
                    int port;
                    if (int.TryParse(args[i + 1], out port) && port >= 1 && port <= 65535)
                    {
                        ViewerForm.ServerBase = "http://localhost:" + port;
                    }
                    break;
                }
            }

            Application.Run(new ViewerForm());
        }
    }

    internal sealed class ViewerForm : Form
    {
        // WDA_EXCLUDEFROMCAPTURE: このウィンドウを画面キャプチャから除外する（鏡写し防止）
        private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

        [DllImport("user32.dll")]
        private static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

        internal static string ServerBase = "http://localhost:3000";
        private string PollUrl { get { return ServerBase + "/socket.io/?EIO=4&transport=polling"; } }

        private readonly PictureBox _picture;
        private readonly Label _status;
        private volatile bool _running = true;
        private Thread _worker;

        public ViewerForm()
        {
            Text = "CraftMate 画面共有ビューア";
            Width = 1024;
            Height = 640;
            MinimumSize = new Size(480, 360);
            StartPosition = FormStartPosition.CenterScreen;

            _picture = new PictureBox();
            _picture.Dock = DockStyle.Fill;
            _picture.SizeMode = PictureBoxSizeMode.Zoom;
            _picture.BackColor = Color.Black;

            _status = new Label();
            _status.Dock = DockStyle.Bottom;
            _status.Height = 28;
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.Padding = new Padding(8, 0, 0, 0);
            _status.BackColor = Color.FromArgb(23, 34, 53);
            _status.ForeColor = Color.White;
            _status.Text = "接続中...";

            Controls.Add(_picture);
            Controls.Add(_status);

            // 画面共有キャプチャに自分自身が映り込まないよう、このウィンドウをキャプチャ対象から除外する
            try { SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE); } catch { }

            _worker = new Thread(ReceiveLoop);
            _worker.IsBackground = true;
            _worker.Start();

            FormClosing += delegate { _running = false; };
        }

        private void SetStatus(string text)
        {
            if (IsDisposed) return;
            try
            {
                if (InvokeRequired)
                {
                    BeginInvoke(new Action(delegate { _status.Text = text; }));
                }
                else
                {
                    _status.Text = text;
                }
            }
            catch { }
        }

        private void ShowImage(string base64)
        {
            if (String.IsNullOrEmpty(base64) || !_running) return;
            try
            {
                byte[] bytes = Convert.FromBase64String(base64);
                using (MemoryStream stream = new MemoryStream(bytes))
                using (Image source = Image.FromStream(stream))
                {
                    Bitmap copy = new Bitmap(source);
                    if (IsDisposed) { copy.Dispose(); return; }
                    try
                    {
                        BeginInvoke(new Action(delegate
                        {
                            Image old = _picture.Image;
                            _picture.Image = copy;
                            if (old != null) old.Dispose();
                        }));
                    }
                    catch
                    {
                        copy.Dispose();
                    }
                }
            }
            catch { }
        }

        private string Poll(string sid)
        {
            string url = PollUrl + (sid == null ? String.Empty : "&sid=" + Uri.EscapeDataString(sid));
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "CraftMate-ScreenViewer";
            request.Proxy = null; // ローカル接続はプロキシを経由させない
            request.Timeout = 45000;
            request.ReadWriteTimeout = 45000;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private void Post(string sid, string payload)
        {
            string url = PollUrl + "&sid=" + Uri.EscapeDataString(sid);
            byte[] bytes = Encoding.UTF8.GetBytes(payload);
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.ContentType = "text/plain;charset=UTF-8";
            request.Proxy = null;
            request.ContentLength = bytes.Length;
            request.Timeout = 15000;
            request.ReadWriteTimeout = 15000;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(bytes, 0, bytes.Length);
            }
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            {
                // レスポンス本文は "ok" のみ。読み捨てる。
            }
        }

        private void ReceiveLoop()
        {
            string sid = null;
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = int.MaxValue;
            int frameCount = 0;
            while (_running)
            {
                try
                {
                    if (sid == null)
                    {
                        string openData = Poll(null);
                        int brace = openData == null ? -1 : openData.IndexOf('{');
                        if (brace < 0)
                        {
                            SetStatus("切断 - 再接続中...");
                            Thread.Sleep(2000);
                            continue;
                        }
                        Dictionary<string, object> openPacket =
                            serializer.DeserializeObject(openData.Substring(brace)) as Dictionary<string, object>;
                        sid = openPacket != null && openPacket.ContainsKey("sid")
                            ? Convert.ToString(openPacket["sid"])
                            : null;
                        if (sid == null)
                        {
                            SetStatus("切断 - 再接続中...");
                            Thread.Sleep(2000);
                            continue;
                        }

                        Post(sid, "40");
                        Post(sid, "42[\"start-screen-share\"]");
                        SetStatus("接続済み");
                    }

                    string data = Poll(sid);
                    if (String.IsNullOrEmpty(data)) continue;

                    string[] packets = data.Split('\u001e');
                    foreach (string packet in packets)
                    {
                        if (packet == "2")
                        {
                            Post(sid, "3");
                            continue;
                        }
                        if (packet.StartsWith("42", StringComparison.Ordinal))
                        {
                            object parsed = serializer.DeserializeObject(packet.Substring(2));
                            // JSON配列は ArrayList または object[] で返る環境があるため IList で受ける
                            System.Collections.IList args = parsed as System.Collections.IList;
                            if (args != null && args.Count >= 2 && Convert.ToString(args[0]) == "bot-screen")
                            {
                                frameCount++;
                                SetStatus("接続済み - 受信フレーム: " + frameCount);
                                ShowImage(Convert.ToString(args[1]));
                            }
                        }
                    }
                }
                catch
                {
                    sid = null;
                    SetStatus("切断 - 再接続中...");
                    Thread.Sleep(2000);
                }
            }
        }
    }
}
