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
        private static string _installDir;
        private static bool _serverRestarted;

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
                        "BlockWhiz を起動できませんでした: " + ex.Message +
                        Environment.NewLine + Environment.NewLine +
                        "詳細ログ: " + LogPath,
                        "BlockWhiz",
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
            _installDir = installDirectory;
            Log("Install directory: " + installDirectory);
            Log("Log file: " + LogPath);

            // アップデート後などに残った「同じインストール先の別 Launcher/CraftMate」
            // プロセスを先に終了する。複数起動するとポート競合や
            // 古いコードのサーバー再利用を招くため。
            KillDuplicateLauncherInstances(installDirectory);

            // ポート3000を占有しているプロセスが「このインストール先の node.exe」
            // でない場合（例: 開発フォルダの古いサーバー）、強制終了して
            // 必ず自分のインストール先のサーバーを起動する。
            // これをしないと Launcher.exe を起動しても古いコードのサーバーが
            // 使われ続け、修正が反映されない状態になる。
            foreach (int foreignPid in GetPortListenerPids(ServerPort))
            {
                if (IsOurServerProcess(foreignPid, installDirectory))
                {
                    Log("Port " + ServerPort + " is held by our own server (PID " + foreignPid + "); reusing it.");
                    continue;
                }
                Log("Port " + ServerPort + " is held by a foreign process (PID " + foreignPid +
                    ") that is not this install's node.exe. Killing it so the correct server can start.");
                KillProcessOnPort(ServerPort);
                Thread.Sleep(1500);
                break; // KillProcessOnPort がポートの全リスナーを処理する
            }

            // サーバーが既に動いているか確認。動いていなければ起動する。
            bool startedByUs = false;
            if (IsServerReady())
            {
                Log("Server is already running on port " + ServerPort + ".");
            }
            else
            {
                Log("Server is not running. Starting node.exe dist\\index.js ...");
                StartServer(installDirectory);
                startedByUs = true;
            }

            if (!WaitForServer())
            {
                // 自分で起動したサーバーが立ち上がらなかった場合は1回だけ再起動を試みる
                if (startedByUs)
                {
                    Log("First server start attempt failed. Retrying once...");
                    KillProcessOnPort(ServerPort);
                    Thread.Sleep(2000);
                    try { StartServer(installDirectory); } catch (Exception retryEx) { Log("Retry start failed: " + retryEx.Message); }
                }
                if (!WaitForServer())
                {
                    Log("ERROR: Server did not become ready on port " + ServerPort + ".");
                    MessageBox.Show(
                        "BlockWhiz server did not become ready on port " + ServerPort +
                        ". Check the installation and try again." +
                        Environment.NewLine + Environment.NewLine +
                        "詳細ログ: " + LogPath,
                        "BlockWhiz",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return;
                }
            }

            // TCPは開いているがHTTPが応答しない「wedged」状態のサーバーを検出する。
            // この状態ではダッシュボードの全ボタンが無反応になるため、自動復旧を試みる。
            if (!VerifyDashboardHttp())
            {
                Log("Server is wedged (TCP ok, HTTP unresponsive). Attempting auto-recovery...");
                KillProcessOnPort(ServerPort);
                Thread.Sleep(3000);
                try
                {
                    StartServer(installDirectory);
                }
                catch (Exception restartEx)
                {
                    Log("Auto-recovery restart failed: " + restartEx.Message);
                }
                if (WaitForServer() && VerifyDashboardHttp())
                {
                    Log("Auto-recovery succeeded.");
                }
                else
                {
                    Log("ERROR: Auto-recovery failed; server still not responding.");
                    MessageBox.Show(
                        "サーバーの自動復旧に失敗しました。PCを再起動してください。" +
                        Environment.NewLine + Environment.NewLine +
                        "詳細ログ: " + LogPath,
                        "BlockWhiz",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return;
                }
            }

            Log("Server is ready. Launching browser...");
            // 起動後の最終掃除: インストール先の node.exe のうち、ポート3000を
            // 掴んでいない残存プロセス（旧バージョンのゾンビ等）を終了する。
            KillStaleInstallDirNodeProcesses(installDirectory);
            Process browserProcess = LaunchBrowser();

            // Launcher を「アプリ全体の監視プロセス」として残す。
            // ブラウザ（アプリモード）が閉じられたら、自分が起動した node.exe や
            // CraftMate関連プロセスを終了してから Launcher 自身も終了する。
            // これによりブラウザを閉じても node.exe がゾンビ化しない。
            if (browserProcess != null)
            {
                Log("Supervisor mode: waiting for the browser window to close...");
                bool quickExit = WaitForBrowserExit(browserProcess);
                if (quickExit)
                {
                    // ブラウザプロセスが起動直後に終了した場合、既存のChrome/Edge
                    // インスタンスへウィンドウが引き継がれた可能性が高い。
                    // この場合ダッシュボードはまだ開いているので、サーバーを
                    // 殺してはいけない。サーバーが応答しなくなるまで監視を続ける。
                    Log("Browser process exited quickly (handed off to existing browser?). Monitoring server instead of killing it.");
                    MonitorServerUntilExit();
                }
                else
                {
                    CleanupOnExit();
                    Log("Shutdown complete. Exiting launcher.");
                }
            }
        }

        /// <summary>
        /// サーバー（ポート3000）が60秒間応答しなくなるまで待機する。
        /// 既存ブラウザへ引き継がれた場合の監視モード用。
        /// </summary>
        private static void MonitorServerUntilExit()
        {
            int unreachableCount = 0;
            while (true)
            {
                Thread.Sleep(5000);
                if (IsServerReady())
                {
                    unreachableCount = 0;
                    continue;
                }
                unreachableCount++;
                Log("Server not responding (" + unreachableCount + "/12 checks).");
                if (unreachableCount >= 12) break; // 約60秒間応答なし
            }
            CleanupOnExit();
            Log("Server went away. Shutdown complete. Exiting launcher.");
        }

        /// <summary>
        /// ブラウザプロセスの終了を監視する。
        /// 戻り値: 起動から20秒以内に終了した場合 true（既存ブラウザへの引き継ぎの可能性）。
        /// </summary>
        private static bool WaitForBrowserExit(Process browserProcess)
        {
            DateTime startTime = DateTime.Now;
            try
            {
                // Chrome は最初のプロセスがブラウザプロセスとして残る。
                // 念のため3秒待って早期終了（起動失敗で即死）を検出する。
                browserProcess.WaitForExit(3000);
                if (browserProcess.HasExited)
                {
                    Log("Browser process already exited (code " + SafeExitCode(browserProcess) + ").");
                    return true;
                }
                int heartbeat = 0;
                while (!browserProcess.HasExited)
                {
                    Thread.Sleep(2000);

                    // ハートビート: Launcher が生きていて監視中であることをログに残す。
                    // これがないと「Launcherが静かに死んだ」のか「監視中」のか区別できない。
                    if (++heartbeat % 15 == 0)
                    {
                        Log("Heartbeat: still monitoring (browser alive, server " +
                            (IsServerReady() ? "ready" : "DOWN") + ").");
                    }

                    // ブラウザは開いたまま node.exe だけが死ぬと、ユーザーには
                    // ERR_CONNECTION_REFUSED しか見えず復旧手段がない。
                    // サーバー終了を検知したら1回だけ自動再起動を試みる。
                    if (_serverProcess != null)
                    {
                        bool serverGone;
                        try { serverGone = _serverProcess.HasExited; }
                        catch { serverGone = true; }
                        if (serverGone && !_serverRestarted && !String.IsNullOrEmpty(_installDir))
                        {
                            _serverRestarted = true;
                            Log("Server process exited while browser is open. Attempting auto-restart...");
                            try
                            {
                                KillProcessOnPort(ServerPort);
                                Thread.Sleep(1500);
                                StartServer(_installDir);
                                if (WaitForServer())
                                {
                                    Log("Auto-restart succeeded; dashboard should recover.");
                                }
                                else
                                {
                                    Log("Auto-restart failed: server did not become ready.");
                                }
                            }
                            catch (Exception restartEx)
                            {
                                Log("Auto-restart failed: " + restartEx.Message);
                            }
                        }
                    }
                }
                Log("Browser closed (code " + SafeExitCode(browserProcess) + ").");
                return (DateTime.Now - startTime).TotalSeconds < 20;
            }
            catch (Exception ex)
            {
                Log("Browser wait failed: " + ex.Message);
                return false;
            }
        }

        private static string SafeExitCode(Process process)
        {
            try { return process.HasExited ? process.ExitCode.ToString() : "running"; }
            catch { return "unknown"; }
        }

        /// <summary>
        /// 終了時クリーンアップ: 自分が起動したサーバーと CraftMate 関連プロセスを終了する。
        /// </summary>
        private static void CleanupOnExit()
        {
            if (_serverProcess != null)
            {
                try
                {
                    if (!_serverProcess.HasExited)
                    {
                        Log("Stopping server process PID " + _serverProcess.Id + ".");
                        _serverProcess.Kill();
                        _serverProcess.WaitForExit(5000);
                    }
                }
                catch (Exception ex)
                {
                    Log("Could not stop server process: " + ex.Message);
                }
                _serverProcess = null;
            }

            // CraftMate の補助プロセス（Updater / ScreenViewer）も終了する
            KillProcessesByName("CraftMate_Updater");
            KillProcessesByName("CraftMate_ScreenViewer");
        }

        /// <summary>
        /// 同一インストール先の Launcher.exe / CraftMate.exe の重複起動を終了する。
        /// 自分自身（selfPid）は対象外。別インストール先のプロセスは触らない。
        /// </summary>
        private static void KillDuplicateLauncherInstances(string installDirectory)
        {
            try
            {
                int selfPid = Process.GetCurrentProcess().Id;
                string installRoot = Path.GetFullPath(installDirectory).TrimEnd('\\') + "\\";
                foreach (Process proc in Process.GetProcesses())
                {
                    try
                    {
                        if (proc.Id == selfPid) continue;
                        string name = proc.ProcessName;
                        if (!string.Equals(name, "CraftMate", StringComparison.OrdinalIgnoreCase) &&
                            !string.Equals(name, "Launcher", StringComparison.OrdinalIgnoreCase)) continue;
                        string exe;
                        try { exe = proc.MainModule == null ? null : proc.MainModule.FileName; }
                        catch { continue; }
                        if (string.IsNullOrEmpty(exe) ||
                            !exe.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase)) continue;
                        Log("Killing duplicate launcher instance PID " + proc.Id + " (" + exe + ").");
                        proc.Kill();
                        proc.WaitForExit(5000);
                    }
                    catch (Exception ex)
                    {
                        Log("Could not kill duplicate launcher PID " + proc.Id + ": " + ex.Message);
                    }
                    finally { try { proc.Dispose(); } catch { } }
                }
            }
            catch (Exception ex)
            {
                Log("Duplicate launcher scan failed: " + ex.Message);
            }
        }

        /// <summary>
        /// インストール先の node.exe のうち、ポート3000のリスナーではないものを終了する。
        /// アップデート後に旧サーバープロセスが残ってメモリを消費するのを防ぐ。
        /// </summary>
        private static void KillStaleInstallDirNodeProcesses(string installDirectory)
        {
            try
            {
                var listenerPids = GetPortListenerPids(ServerPort);
                int serverPid = (_serverProcess != null && !_serverProcess.HasExited) ? _serverProcess.Id : -1;
                Log("Port " + ServerPort + " listeners: [" + string.Join(",", listenerPids) + "] serverPid=" + serverPid);
                if (listenerPids.Count == 0)
                {
                    // リスナーを検出できない場合は誤って自サーバーを殺さないよう掃除をスキップ
                    Log("No port listeners detected; skipping stale-node sweep for safety.");
                    return;
                }
                string expectedNode = Path.GetFullPath(Path.Combine(installDirectory, "node.exe"));
                foreach (Process proc in Process.GetProcessesByName("node"))
                {
                    try
                    {
                        if (proc.Id == serverPid) continue;             // 自分が起動したサーバーは絶対に残す
                        if (listenerPids.Contains(proc.Id)) continue;   // ポート占有中のサーバーも残す
                        string exe;
                        try { exe = proc.MainModule == null ? null : proc.MainModule.FileName; }
                        catch { continue; }
                        if (string.IsNullOrEmpty(exe) ||
                            !string.Equals(Path.GetFullPath(exe), expectedNode, StringComparison.OrdinalIgnoreCase)) continue;
                        Log("Killing stale node.exe PID " + proc.Id + " (not listening on port " + ServerPort + ").");
                        proc.Kill();
                        proc.WaitForExit(5000);
                    }
                    catch (Exception ex)
                    {
                        Log("Could not kill stale node PID " + proc.Id + ": " + ex.Message);
                    }
                    finally { try { proc.Dispose(); } catch { } }
                }
            }
            catch (Exception ex)
            {
                Log("Stale node scan failed: " + ex.Message);
            }
        }

        private static void KillProcessesByName(string processName)
        {
            try
            {
                foreach (Process proc in Process.GetProcessesByName(processName))
                {
                    try
                    {
                        Log("Stopping " + processName + " PID " + proc.Id + ".");
                        proc.Kill();
                        proc.WaitForExit(3000);
                    }
                    catch (Exception ex)
                    {
                        Log("Could not stop " + processName + " PID " + proc.Id + ": " + ex.Message);
                    }
                    finally { proc.Dispose(); }
                }
            }
            catch (Exception ex)
            {
                Log("Process scan for " + processName + " failed: " + ex.Message);
            }
        }

        /// <summary>
        /// 指定ポートを LISTEN しているプロセスのPID一覧を netstat から取得する。
        /// </summary>
        private static System.Collections.Generic.HashSet<int> GetPortListenerPids(int port)
        {
            var pids = new System.Collections.Generic.HashSet<int>();
            // netstat -ano は IPv6 ワイルドカード ([::]:port) の LISTEN を
            // 環境によって出力しないことがあるため、Get-NetTCPConnection でも補完する。
            try
            {
                Process ps = Process.Start(new ProcessStartInfo("powershell.exe",
                    "-NoProfile -NonInteractive -Command \"Get-NetTCPConnection -LocalPort " + port +
                    " -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                });
                if (ps != null)
                {
                    string psOut = ps.StandardOutput.ReadToEnd();
                    ps.WaitForExit(15000);
                    foreach (string token in psOut.Split(new char[] { ' ', '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        int pid;
                        if (int.TryParse(token, out pid) && pid > 0) pids.Add(pid);
                    }
                }
            }
            catch (Exception ex)
            {
                Log("Get-NetTCPConnection lookup failed: " + ex.Message);
            }
            try
            {
                Process netstat = Process.Start(new ProcessStartInfo("netstat", "-ano")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                });
                if (netstat == null) { Log("netstat could not be started."); return pids; }
                string output = netstat.StandardOutput.ReadToEnd();
                netstat.WaitForExit(10000);
                foreach (string line in output.Split('\n'))
                {
                    // TCP  127.0.0.1:3000  0.0.0.0:0  LISTENING  1234
                    string[] parts = line.Trim().Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 5) continue;
                    if (!parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
                    string local = parts[1];
                    if (!local.EndsWith(":" + port, StringComparison.Ordinal)) continue;
                    int pid;
                    if (int.TryParse(parts[4], out pid) && pid > 0) pids.Add(pid);
                }
            }
            catch (Exception ex)
            {
                Log("netstat lookup failed: " + ex.Message);
            }
            return pids;
        }

        /// <summary>
        /// 指定PIDのプロセスが「このインストール先の node.exe」かどうかを判定する。
        /// MainModule のパスが installDirectory\node.exe と一致すれば自サーバーとみなす。
        /// 判定不能（権限不足など）の場合は false を返し、呼び出し側で安全側（再起動）に倒す。
        /// </summary>
        private static bool IsOurServerProcess(int pid, string installDirectory)
        {
            try
            {
                using (Process proc = Process.GetProcessById(pid))
                {
                    if (!string.Equals(proc.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
                        return false;
                    string modulePath = null;
                    try { modulePath = proc.MainModule == null ? null : proc.MainModule.FileName; }
                    catch { return false; }
                    if (String.IsNullOrEmpty(modulePath)) return false;
                    string expected = Path.GetFullPath(Path.Combine(installDirectory, "node.exe"));
                    return String.Equals(Path.GetFullPath(modulePath), expected, StringComparison.OrdinalIgnoreCase);
                }
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// 指定ポートを LISTEN しているプロセスを特定して終了する。
        /// netstat -ano の出力からPIDを取得し、node.exe の場合のみ kill する
        /// （他アプリのnodeプロセスを誤って終了しないため）。
        /// </summary>
        private static void KillProcessOnPort(int port)
        {
            var pids = GetPortListenerPids(port);

            foreach (int pid in pids)
            {
                try
                {
                    using (Process proc = Process.GetProcessById(pid))
                    {
                        if (!string.Equals(proc.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
                        {
                            Log("Port " + port + " is held by non-node process PID " + pid + " (" + proc.ProcessName + "); skipping.");
                            continue;
                        }
                        Log("Killing wedged node.exe PID " + pid + " holding port " + port + ".");
                        proc.Kill();
                        proc.WaitForExit(5000);
                    }
                }
                catch (Exception ex)
                {
                    Log("Could not kill PID " + pid + ": " + ex.Message);
                }
            }
            if (pids.Count == 0) Log("No LISTENING process found on port " + port + ".");
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
            // node.exe が終了した理由（クラッシュ/kill/idle shutdown）を必ずログに残す。
            // これがないと「サーバーが突然死んだ」ケースを追跡できない。
            server.EnableRaisingEvents = true;
            server.Exited += delegate(object s, EventArgs e)
            {
                try
                {
                    int code = server.HasExited ? server.ExitCode : -1;
                    Log("[server] node.exe exited (code " + code + ").");
                }
                catch { Log("[server] node.exe exited."); }
            };

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

            // Launcher が終了（または強制終了）された際に node.exe が
            // ゾンビ化しないよう、kill-on-close ジョブに割り当てる
            AssignToKillOnCloseJob(server);

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

        private static Process LaunchBrowser()
        {
            string browser = FindBrowser();
            if (browser == null)
            {
                Log("ERROR: No supported browser found.");
                MessageBox.Show(
                    "開けるブラウザが見つかりません。ChromeかEdgeをインストールしてください。",
                    "BlockWhiz",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return null;
            }
            Log("Browser: " + browser);

            Process browserProcess = null;
            try
            {
                string profileDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "BlockWhiz",
                    "BrowserProfile");
                Directory.CreateDirectory(profileDirectory);

                // --app= でデスクトップアプリ風に開く。Chrome/Edge はどちらもChromium系。
                string arguments =
                    "--app=" + DashboardUrl +
                    " --user-data-dir=\"" + profileDirectory + "\"" +
                    " --no-first-run --no-default-browser-check";

                browserProcess = Process.Start(
                    new ProcessStartInfo(browser, arguments) { UseShellExecute = false });
                if (browserProcess == null)
                {
                    throw new InvalidOperationException("ブラウザプロセスを起動できませんでした。");
                }
                Log("Browser launched (PID " + browserProcess.Id + ").");
            }
            catch (Exception browserError)
            {
                Log("Browser launch failed: " + browserError);
                MessageBox.Show(
                    "ブラウザの起動に失敗しました: " + browserError.Message,
                    "BlockWhiz",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return null;
            }
            return browserProcess;
        }

        // ---- Job Object (KILL_ON_JOB_CLOSE) ----
        // Launcher が強制終了されても、配下の node.exe がゾンビ化しないようにする。
        // ジョブに割り当てたプロセスは、その子プロ孫プロセスにも継承されるため、
        // サーバーの自己再起動で spawn された新しい node.exe も連動して終了する。
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private static IntPtr _killOnCloseJob = IntPtr.Zero;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        /// <summary>
        /// 指定プロセスを「Launcher 終了時に一緒に kill される」Job Object に割り当てる。
        /// 失敗しても起動自体は継続する（ベストエフォート）。
        /// </summary>
        private static void AssignToKillOnCloseJob(Process process)
        {
            try
            {
                if (_killOnCloseJob == IntPtr.Zero)
                {
                    _killOnCloseJob = CreateJobObject(IntPtr.Zero, null);
                    if (_killOnCloseJob == IntPtr.Zero)
                    {
                        Log("CreateJobObject failed: " + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
                        return;
                    }
                    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64: 128 bytes)
                    // LimitFlags は先頭から 16 バイト目 (BasicLimitInformation 内)
                    IntPtr info = System.Runtime.InteropServices.Marshal.AllocHGlobal(128);
                    try
                    {
                        for (int i = 0; i < 128; i++) System.Runtime.InteropServices.Marshal.WriteByte(info, i, 0);
                        System.Runtime.InteropServices.Marshal.WriteInt32(info, 16, (int)JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
                        if (!SetInformationJobObject(_killOnCloseJob, JobObjectExtendedLimitInformation, info, 128))
                        {
                            Log("SetInformationJobObject failed: " + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
                            CloseHandle(_killOnCloseJob);
                            _killOnCloseJob = IntPtr.Zero;
                            return;
                        }
                    }
                    finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(info); }
                    Log("Kill-on-close Job Object created.");
                }
                if (AssignProcessToJobObject(_killOnCloseJob, process.Handle))
                {
                    Log("Server process PID " + process.Id + " assigned to kill-on-close job.");
                }
                else
                {
                    Log("AssignProcessToJobObject failed (PID " + process.Id + "): " + System.Runtime.InteropServices.Marshal.GetLastWin32Error() + " (continuing without job protection)");
                }
            }
            catch (Exception ex)
            {
                Log("Job Object setup failed: " + ex.Message);
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
