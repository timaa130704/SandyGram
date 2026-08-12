// SandyGram Desktop — нативный Windows-клиент (WPF), общий Firebase с сайтом и приложением
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace SandyGram;

public partial class MainWindow : Window
{
    const string Site = "https://sandygram-a3b42.web.app";
    static readonly string[] AvatarTones = { "#F3EDFF", "#E8DDFD", "#DCCFFB", "#CFC0F8", "#C2B1F4", "#B5A2F0", "#A893EC" };
    static readonly string SessionFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SandyGram", "session.json");
    static readonly string SessionIdFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SandyGram", "session-id.txt");
    string mySessionId = "";

    string myUsername = "", myDisplayName = "";
    readonly Dictionary<string, JsonNode> chats = new();          // chatId -> fields
    readonly Dictionary<string, JsonNode> userCache = new();      // uid -> fields
    readonly Dictionary<string, DateTime> userCacheAt = new();
    readonly Dictionary<string, long> lastSoundUnread = new();     // chatId -> последний звуковой unread
    string currentChatId = "";
    string lastMsgSignature = "";
    string lastListSignature = "";
    readonly List<(string Id, JsonNode Fields)> loadedMsgs = new(); // сообщения открытого чата (локальный кеш)
    long lastMaxCreated = 0;                                        // для дельта-запросов
    long lastTicksMark = 0;
    bool sending = false;
    string searchFilter = "";
    readonly Dictionary<string, string> drafts = new();
    string currentTopicId = "";            // "" = обычный чат; для форумов id открытого топика
    (string Id, string Sender, string Text)? replyTo = null;
    string replyTargetUid = "";            // uid автора, на чьё сообщение отвечают (для /mute и т.п.)
    static readonly System.Text.RegularExpressions.Regex ModCmdRe = new(@"^/(mute|warn|ban|unmute|unban|info|theme|help|saved)\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    const long PermanentUntil = 4102444800000L; // ~2100 год: «навсегда»
    NAudio.Wave.WaveInEvent? recorder;
    NAudio.Wave.WaveFileWriter? recWriter;
    string recPath = "";
    DateTime recStart;
    static string Bq(string v) => "\u0060" + v + "\u0060"; // обратные кавычки для спец-ключей в путях полей
    static readonly string[] StickerCodes = { "1F600","1F602","1F60D","1F60E","1F914","1F644","1F62D","1F621","1F973","1F97A","1F480","1F4A9","1F525","2764","1F44D","1F44E","1F44C","1F64F","1F4AA","1F440","1F389","1F680","26A1","1F31A","1F31D","1F63B","1F63C","1F998","1F984","1F37F" };
    DispatcherTimer? chatsTimer, msgsTimer, presenceTimer;
    System.Threading.CancellationTokenSource? sseCts;
    System.Threading.CancellationTokenSource? qrCts;
    string qrToken = "";
    const string Rtdb = "https://sandygram-a3b42-default-rtdb.europe-west1.firebasedatabase.app";

    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public MainWindow()
    {
        InitializeComponent();
        BuildFormatMenu(); // ПКМ в поле ввода — начертания выделенного текста
        // тёмный заголовок окна (Windows 10 1809+)
        SourceInitialized += (_, _) =>
        {
            var hwnd = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            int dark = 1;
            DwmSetWindowAttribute(hwnd, 20, ref dark, sizeof(int));
        };
        Loaded += async (_, _) => await TryRestoreSessionAsync();
    }

    // ================================================================ auth
    static string EmailFor(string u) => $"{u}@sandygram.app";

    async Task TryRestoreSessionAsync()
    {
        try
        {
            if (!File.Exists(SessionFile)) return;
            var s = JsonNode.Parse(File.ReadAllText(SessionFile))!;
            Fire.RefreshToken = s["refreshToken"]?.GetValue<string>() ?? "";
            if (string.IsNullOrEmpty(Fire.RefreshToken)) return;
            await Fire.EnsureTokenAsync();
            await AfterLoginAsync();
        }
        catch { /* остаёмся на экране входа */ }
    }

    void SaveSession()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(SessionFile)!);
        File.WriteAllText(SessionFile, JsonSerializer.Serialize(new { refreshToken = Fire.RefreshToken }));
    }

    async void LoginBtn_Click(object sender, RoutedEventArgs e) => await AuthFlowAsync(register: false);
    async void RegisterBtn_Click(object sender, RoutedEventArgs e) => await AuthFlowAsync(register: true);

    async Task AuthFlowAsync(bool register)
    {
        var name = LoginUser.Text.Trim().ToLowerInvariant().TrimStart('@');
        var pass = LoginPass.Password;
        AuthError.Text = "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z0-9_]{3,24}$")) { AuthError.Text = "Имя: 3–24 символа, латиница, цифры и _"; return; }
        if (pass.Length < 6) { AuthError.Text = "Пароль: минимум 6 символов"; return; }
        LoginBtn.IsEnabled = RegisterBtn.IsEnabled = false;
        try
        {
            var reg = await Fire.AuthNoThrowGetUsernameDoc(name);
            var email = reg?["fields"]?["email"] != null ? Fire.FStr(reg["fields"]!, "email") : EmailFor(name);
            if (register)
            {
                if (reg != null)
                {
                    // имя занято — возможно, наша оборванная регистрация: пробуем войти
                    try { await Fire.SignInAsync(email, pass); }
                    catch { throw new FireException("EMAIL_EXISTS"); }
                }
                else
                {
                    try { await Fire.SignUpAsync(EmailFor(name), pass); }
                    catch (FireException ex) when (ex.Message.Contains("EMAIL_EXISTS")) { await Fire.SignInAsync(EmailFor(name), pass); }
                }
                await EnsureProfileAsync(name);
            }
            else
            {
                await Fire.SignInAsync(email, pass);
                await EnsureProfileAsync(name); // самопочинка оборванной регистрации
            }
            SaveSession();
            await AfterLoginAsync();
        }
        catch (FireException ex) { AuthError.Text = ex.Ru; }
        catch (Exception ex) { AuthError.Text = ex.Message; }
        finally { LoginBtn.IsEnabled = RegisterBtn.IsEnabled = true; }
    }

    // ============ вход по QR (телефон сканирует, передаёт refresh-токен) ============
void QrBtn_Click(object sender, RoutedEventArgs e)
    {
        if (QrPanel.Visibility == Visibility.Visible) { StopQr(); return; }
        QrStatus.Text = ""; QrPanel.Visibility = Visibility.Visible; QrBtn.IsEnabled = false;
        LoginBtn.IsEnabled = RegisterBtn.IsEnabled = false;
        qrCts?.Cancel(); qrCts = new System.Threading.CancellationTokenSource();
        qrToken = Fire.SecureToken(16);
        var payload = $"{Site}/qr/{qrToken}";
        _ = Fire.PutRtdbJsonAsync($"qrlogin/{qrToken}", new { status = "pending", created = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }).ConfigureAwait(false);
        RenderQr(payload);
        _ = WatchQrAsync();
    }

    void RenderQr(string payload)
    {
        var qr = new QRCoder.QRCodeGenerator().CreateQrCode(payload, QRCoder.QRCodeGenerator.ECCLevel.M);
        var png = new QRCoder.PngByteQRCode(qr).GetGraphic(4);
        using var ms = new MemoryStream(png);
        var bmp = new BitmapImage();
        bmp.BeginInit(); bmp.StreamSource = ms; bmp.CacheOption = BitmapCacheOption.OnLoad; bmp.EndInit();
        bmp.Freeze();
        QrImage.Source = bmp;
    }

    async Task WatchQrAsync()
    {
        try
        {
            var deadline = DateTime.UtcNow.AddMinutes(2);
            while (!qrCts!.IsCancellationRequested)
            {
                try
                {
                    var node = await Fire.GetRtdbJsonAsync($"qrlogin/{qrToken}");
                    var refresh = node?["refresh"]?.GetValue<string>();
                    if (!string.IsNullOrEmpty(refresh))
                    {
                        await Fire.SignInWithRefreshTokenAsync(refresh);
                        await Fire.DeleteRtdbAsync($"qrlogin/{qrToken}");
                        SaveSession();
                        await AfterLoginAsync();
                        Dispatcher.Invoke(StopQr);
                        return;
                    }
                }
                catch (FireException fe) { Dispatcher.Invoke(() => { QrStatus.Text = fe.Ru; QrBtn.IsEnabled = true; }); return; }
                catch { }
                if (DateTime.UtcNow > deadline) { Dispatcher.Invoke(() => { QrStatus.Text = "Срок истёк — нажмите ещё раз."; QrBtn.IsEnabled = true; }); return; }
                await Task.Delay(700, qrCts.Token).ConfigureAwait(false);
            }
        }
        catch (TaskCanceledException) { }
        catch { }
    }

    void StopQr()
    {
        qrCts?.Cancel();
        QrPanel.Visibility = Visibility.Collapsed;
        QrBtn.IsEnabled = LoginBtn.IsEnabled = RegisterBtn.IsEnabled = true;
    }
    void QrCancelBtn_Click(object sender, RoutedEventArgs e) => StopQr();

    async Task EnsureProfileAsync(string name)
    {
        var prof = await Fire.GetDocAsync($"users/{Fire.Uid}");
        if (prof == null)
        {
            await Fire.SetDocAsync($"users/{Fire.Uid}", new()
            {
                ["username"] = name, ["displayName"] = name, ["bio"] = "",
                ["avatarColor"] = (long)Random.Shared.Next(7),
                ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["lastSeen"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });
        }
        var unameDoc = await Fire.GetDocAsync($"usernames/{name}");
        if (unameDoc == null)
            await Fire.SetDocAsync($"usernames/{name}", new() { ["uid"] = Fire.Uid, ["email"] = EmailFor(name) });
        var saved = await Fire.GetDocAsync($"chats/saved_{Fire.Uid}");
        if (saved == null)
            await Fire.SetDocAsync($"chats/saved_{Fire.Uid}", new()
            {
                ["type"] = "saved",
                ["members"] = new List<object?> { Fire.Uid },
                ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["lastRead"] = new Dictionary<string, object?>(),
                ["unread"] = new Dictionary<string, object?>(),
                ["pinnedBy"] = new List<object?>(),
                ["muted"] = new List<object?>(),
            });
    }

    async Task AfterLoginAsync()
    {
        var prof = await Fire.GetDocAsync($"users/{Fire.Uid}");
        if (prof?["fields"] == null) { AuthError.Text = "Профиль не найден — зарегистрируйтесь заново."; return; }
        myUsername = Fire.FStr(prof["fields"]!, "username");
        myDisplayName = Fire.FStr(prof["fields"]!, "displayName");
        MyName.Text = myDisplayName;
        MyHandle.Text = $"@{myUsername}";
        var myTone = AvatarTones[Math.Abs((int)Fire.FLong(prof["fields"]!, "avatarColor")) % 7];
        var myPhoto = Fire.FStr(prof["fields"]!, "avatar");
        MyAvatar.Content = MakeAvatar(myDisplayName.Length > 0 ? myDisplayName[..1].ToUpper() : "S", myTone, myPhoto.Length > 0 ? myPhoto : null, 40);
        AuthPanel.Visibility = Visibility.Collapsed;
        MainPanel.Visibility = Visibility.Visible;

        // Realtime через сигнальную шину RTDB (одно живое соединение, чтения Firestore — только по факту событий)
        await RegisterSessionAsync();
        if (await SessionRevokedAsync()) { MessageBox.Show("Сессия завершена с другого устройства.", "SandyGram"); LogoutBtn_Click(this, new RoutedEventArgs()); return; }

        StartBumpListener();
        chatsTimer = StartTimer(90, async () => { if (IsActive) await PollChatsAsync(); }); // редкая страховка
        presenceTimer = StartTimer(45, async () => { if (IsActive) await HeartbeatAsync(); });
        await HeartbeatAsync();
        await PollChatsAsync();
    }

    // ---------- вход через Google (браузер + локальный колбэк) ----------
    string pendingEmail = "", pendingName = "", pendingPhoto = "";

    async void GoogleBtn_Click(object sender, RoutedEventArgs e)
    {
        AuthError.Text = "";
        GoogleBtn.IsEnabled = false;
        System.Net.HttpListener? listener = null;
        try
        {
            var port = GetFreePort();
            listener = new System.Net.HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Start();
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo($"{Site}/desktop-auth.html?port={port}") { UseShellExecute = true });
            AuthError.Text = "Ожидаю вход в браузере…";

            var receive = Task.Run(async () =>
            {
                while (true)
                {
                    var ctx = await listener.GetContextAsync();
                    if (ctx.Request.HttpMethod == "POST" && ctx.Request.Url!.AbsolutePath == "/callback")
                    {
                        string body;
                        using (var r = new StreamReader(ctx.Request.InputStream)) body = await r.ReadToEndAsync();
                        ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
                        var ok = System.Text.Encoding.UTF8.GetBytes("ok");
                        await ctx.Response.OutputStream.WriteAsync(ok);
                        ctx.Response.Close();
                        return body;
                    }
                    ctx.Response.StatusCode = 404;
                    ctx.Response.Close();
                }
            });
            var done = await Task.WhenAny(receive, Task.Delay(TimeSpan.FromMinutes(3)));
            if (done != receive) throw new Exception("Время ожидания входа истекло — попробуйте ещё раз.");
            var j = JsonNode.Parse(await receive)!;

            Fire.RefreshToken = j["refreshToken"]!.GetValue<string>();
            await Fire.EnsureTokenAsync();
            AuthError.Text = "";

            var prof = await Fire.GetDocAsync($"users/{Fire.Uid}");
            if (prof == null)
            {
                // первый вход через Google — выбираем @username
                pendingEmail = j["email"]?.GetValue<string>() ?? "";
                pendingName = j["displayName"]?.GetValue<string>() ?? "";
                pendingPhoto = j["photoURL"]?.GetValue<string>() ?? "";
                var suggest = new string((pendingEmail.Split('@')[0].ToLowerInvariant()).Where(c => char.IsAsciiLetterOrDigit(c) || c == '_').ToArray());
                PickName.Text = suggest.Length >= 3 ? suggest : "user" + Random.Shared.Next(1000, 9999);
                AuthPanel.Visibility = Visibility.Collapsed;
                PickPanel.Visibility = Visibility.Visible;
                return;
            }
            SaveSession();
            await AfterLoginAsync();
        }
        catch (FireException ex) { AuthError.Text = ex.Ru; }
        catch (Exception ex) { AuthError.Text = ex.Message; }
        finally { GoogleBtn.IsEnabled = true; try { listener?.Stop(); } catch { } }
    }

    static int GetFreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        var port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    async void PickBtn_Click(object sender, RoutedEventArgs e)
    {
        var name = PickName.Text.Trim().ToLowerInvariant().TrimStart('@');
        PickError.Text = "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[a-z0-9_]{3,24}$")) { PickError.Text = "3–24 символа: латиница, цифры и _"; return; }
        PickBtn.IsEnabled = false;
        try
        {
            var taken = await Fire.GetDocAsync($"usernames/{name}");
            if (taken?["fields"] != null && Fire.FStr(taken["fields"]!, "uid") != Fire.Uid) { PickError.Text = "Это имя уже занято."; return; }
            if (taken == null)
                await Fire.SetDocAsync($"usernames/{name}", new() { ["uid"] = Fire.Uid, ["email"] = pendingEmail.Length > 0 ? pendingEmail : EmailFor(name), ["google"] = true });
            var fields = new Dictionary<string, object?>
            {
                ["username"] = name,
                ["displayName"] = pendingName.Length > 0 ? (pendingName.Length > 40 ? pendingName[..40] : pendingName) : name,
                ["bio"] = "",
                ["avatarColor"] = (long)Random.Shared.Next(7),
                ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["lastSeen"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            if (pendingPhoto.Length > 0) fields["avatar"] = pendingPhoto;
            await Fire.SetDocAsync($"users/{Fire.Uid}", fields);
            var saved = await Fire.GetDocAsync($"chats/saved_{Fire.Uid}");
            if (saved == null)
                await Fire.SetDocAsync($"chats/saved_{Fire.Uid}", new()
                {
                    ["type"] = "saved", ["members"] = new List<object?> { Fire.Uid },
                    ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["lastRead"] = new Dictionary<string, object?>(), ["unread"] = new Dictionary<string, object?>(),
                    ["pinnedBy"] = new List<object?>(), ["muted"] = new List<object?>(),
                });
            SaveSession();
            PickPanel.Visibility = Visibility.Collapsed;
            await AfterLoginAsync();
        }
        catch (FireException ex) { PickError.Text = ex.Ru; }
        catch (Exception ex) { PickError.Text = ex.Message; }
        finally { PickBtn.IsEnabled = true; }
    }

    // ---------- новый чат ----------
    void NewChatBtn_Click(object sender, RoutedEventArgs e) { NewChatPanel.Visibility = Visibility.Visible; UserSearch.Focus(); }
    void CloseNewChat_Click(object sender, RoutedEventArgs e) => NewChatPanel.Visibility = Visibility.Collapsed;

    System.Threading.CancellationTokenSource? searchCts;
    async void UserSearch_Changed(object sender, TextChangedEventArgs e)
    {
        searchCts?.Cancel();
        var cts = searchCts = new System.Threading.CancellationTokenSource();
        var q = UserSearch.Text.Trim().ToLowerInvariant().TrimStart('@');
        UserResults.Children.Clear();
        if (q.Length < 1) return;
        try { await Task.Delay(350, cts.Token); } catch { return; }
        try
        {
            var rows = await Fire.RunQueryAsync(new
            {
                from = new[] { new { collectionId = "users" } },
                where = new
                {
                    compositeFilter = new
                    {
                        op = "AND",
                        filters = new object[]
                        {
                            new { fieldFilter = new { field = new { fieldPath = "username" }, op = "GREATER_THAN_OR_EQUAL", value = new { stringValue = q } } },
                            new { fieldFilter = new { field = new { fieldPath = "username" }, op = "LESS_THAN_OR_EQUAL", value = new { stringValue = q + "\uf8ff" } } },
                        },
                    },
                },
                limit = 15,
            });
            if (cts.IsCancellationRequested) return;
            foreach (var (uid, uf) in rows)
            {
                if (uid == Fire.Uid) continue;
                var name = Fire.FStr(uf, "displayName");
                var uname = Fire.FStr(uf, "username");
                var tone = AvatarTones[Math.Abs((int)Fire.FLong(uf, "avatarColor")) % 7];
                var photo = Fire.FStr(uf, "avatar");
                var row = new Border { Style = (Style)FindResource("ChatRow"), Padding = new Thickness(8, 7, 8, 7) };
                var g = new Grid();
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                g.Children.Add(MakeAvatar(name.Length > 0 ? name[..1].ToUpper() : "?", tone, photo.Length > 0 ? photo : null, 38));
                var sp = new StackPanel { Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
                sp.Children.Add(new TextBlock { Text = name, FontWeight = FontWeights.Bold, FontSize = 13.5, Foreground = (Brush)FindResource("Text") });
                sp.Children.Add(new TextBlock { Text = "@" + uname, FontSize = 11.5, Foreground = (Brush)FindResource("Muted") });
                Grid.SetColumn(sp, 1);
                g.Children.Add(sp);
                row.Child = g;
                var targetUid = uid;
                row.MouseLeftButtonUp += async (_, _) => await OpenDmWithAsync(targetUid);
                UserResults.Children.Add(row);
            }
            if (UserResults.Children.Count == 0)
                UserResults.Children.Add(new TextBlock { Text = "Никого не найдено", Foreground = (Brush)FindResource("Muted"), Margin = new Thickness(8) });
        }
        catch { }
    }

    async Task OpenDmWithAsync(string targetUid)
    {
        try
        {
            var ids = new[] { Fire.Uid, targetUid }.OrderBy(x => x).ToArray();
            var chatId = $"dm_{ids[0]}_{ids[1]}";
            var existing = await Fire.GetDocAsync($"chats/{chatId}");
            if (existing == null)
            {
                await Fire.SetDocAsync($"chats/{chatId}", new()
                {
                    ["type"] = "private",
                    ["members"] = new List<object?> { ids[0], ids[1] },
                    ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ["lastRead"] = new Dictionary<string, object?>(),
                    ["unread"] = new Dictionary<string, object?>(),
                    ["pinnedBy"] = new List<object?>(),
                    ["muted"] = new List<object?>(),
                });
                await AllowPeerReplyAsync(targetUid);
            }
            NewChatPanel.Visibility = Visibility.Collapsed;
            await PollChatsAsync();
            await OpenChatAsync(chatId);
        }
        catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
    }

    // Я сам начал чат — разрешаю собеседнику отвечать (в режиме «Никто» список заморожен).
    async Task AllowPeerReplyAsync(string peerUid)
    {
        try
        {
            var prefs = await Fire.GetDocAsync($"users/{Fire.Uid}/private/prefs");
            var f = prefs?["fields"];
            var mode = f == null ? "all" : Fire.FStr(f, "dmMode");
            if (mode.Length == 0) mode = (f != null && Fire.FBool(f, "dmClosed")) ? "contacts" : "all";
            if (mode == "none") return;
            var allow = (f == null ? new List<object?>() : Fire.FList(f, "dmAllow")).Select(x => x?.ToString()).ToList();
            if (allow.Contains(peerUid)) return;
            allow.Add(peerUid);
            await Fire.PatchDocAsync($"users/{Fire.Uid}/private/prefs",
                new Dictionary<string, object?> { ["dmAllow"] = allow.Cast<object?>().ToList() });
        }
        catch { /* необязательное удобство, не критично */ }
    }

    async void CreateGroup_Click(object sender, RoutedEventArgs e) => await CreateGroupChatAsync("group");
    async void CreateChannel_Click(object sender, RoutedEventArgs e) => await CreateGroupChatAsync("channel");
    async Task CreateGroupChatAsync(string kind)
    {
        var title = NewGroupTitle.Text.Trim();
        if (title.Length == 0) { MessageBox.Show("Введите название", "SandyGram"); return; }
        try
        {
            var chatId = $"grp_{Fire.RandomId(16)}";
            await Fire.SetDocAsync($"chats/{chatId}", new()
            {
                ["type"] = kind,
                ["title"] = title.Length > 60 ? title[..60] : title,
                ["members"] = new List<object?> { Fire.Uid },
                ["ownerUid"] = Fire.Uid,
                ["admins"] = new List<object?>(),
                ["avatarColor"] = (long)Random.Shared.Next(7),
                ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["lastRead"] = new Dictionary<string, object?>(),
                ["unread"] = new Dictionary<string, object?>(),
                ["pinnedBy"] = new List<object?>(),
                ["muted"] = new List<object?>(),
            });
            NewGroupTitle.Text = "";
            NewChatPanel.Visibility = Visibility.Collapsed;
            await PollChatsAsync();
            await OpenChatAsync(chatId);
        }
        catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
    }

    void SearchBox_Changed(object sender, TextChangedEventArgs e)
    {
        searchFilter = SearchBox.Text.Trim().ToLowerInvariant();
        lastListSignature = "";
        _ = RenderChatListAsync();
    }

    // ---------- 3.0 блок C: сессии, журнал безопасности ----------
    // Мгновенный отзыв токена умеет только Admin SDK, которого у нас нет.
    // Поэтому «выйти везде» — метка revokeBefore в private/prefs: каждый клиент,
    // увидев её при запуске, выходит сам. Называем вещи своими именами в UI.
    async Task RegisterSessionAsync()
    {
        try
        {
            bool fresh = !File.Exists(SessionIdFile);
            if (fresh)
            {
                mySessionId = Guid.NewGuid().ToString("N")[..16];
                Directory.CreateDirectory(Path.GetDirectoryName(SessionIdFile)!);
                File.WriteAllText(SessionIdFile, mySessionId);
            }
            else mySessionId = File.ReadAllText(SessionIdFile).Trim();

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var fields = new Dictionary<string, object?> { ["platform"] = "desktop", ["label"] = "Приложение Windows", ["lastSeen"] = now };
            if (fresh) fields["createdAt"] = now;
            await Fire.PatchDocAsync($"users/{Fire.Uid}/sessions/{mySessionId}", fields);
            if (fresh) await SecLogAsync("login", "новое устройство: Windows");
        }
        catch { /* сессии не критичны для работы мессенджера */ }
    }

    async Task SecLogAsync(string type, string detail = "")
    {
        try
        {
            await Fire.SetDocAsync($"users/{Fire.Uid}/seclog/{Guid.NewGuid():N}", new Dictionary<string, object?>
            {
                ["type"] = type,
                ["detail"] = detail.Length > 200 ? detail[..200] : detail,
                ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["platform"] = "Windows",
            });
        }
        catch { }
    }

    async Task<bool> SessionRevokedAsync()
    {
        try
        {
            var prefs = await Fire.GetDocAsync($"users/{Fire.Uid}/private/prefs");
            var revoke = prefs?["fields"] == null ? 0 : Fire.FLong(prefs["fields"]!, "revokeBefore");
            if (revoke <= 0) return false;
            var mine = await Fire.GetDocAsync($"users/{Fire.Uid}/sessions/{mySessionId}");
            var born = mine?["fields"] == null ? 0 : Fire.FLong(mine["fields"]!, "createdAt");
            if (born > 0 && born < revoke) { try { File.Delete(SessionIdFile); } catch { } return true; }
        }
        catch { }
        return false;
    }

    async void SecurityBtn_Click(object sender, RoutedEventArgs e)
    {
        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(new TextBlock { Text = "Активные сессии", FontWeight = FontWeights.Bold, FontSize = 15, Margin = new Thickness(0, 0, 0, 8) });
        var list = new StackPanel();
        panel.Children.Add(list);
        panel.Children.Add(new TextBlock
        {
            Text = "«Выйти везде» помечает старые сессии отозванными — устройство выйдет при следующем запуске. " +
                   "Мгновенный отзыв требует серверного ключа, которого у нас нет.",
            TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.7, Margin = new Thickness(0, 8, 0, 8),
        });
        var kill = new Button { Content = "Выйти на всех устройствах", Padding = new Thickness(12, 7, 12, 7), HorizontalAlignment = HorizontalAlignment.Left };
        panel.Children.Add(kill);
        panel.Children.Add(new TextBlock { Text = "Журнал безопасности", FontWeight = FontWeights.Bold, FontSize = 15, Margin = new Thickness(0, 16, 0, 8) });
        var log = new StackPanel();
        panel.Children.Add(log);

        var win = new Window
        {
            Title = "Безопасность", Width = 460, Height = 560, Owner = this,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
        };

        async Task ReloadAsync()
        {
            list.Children.Clear(); log.Children.Clear();
            var sessions = await Fire.RunQueryAsync(new
            {
                from = new[] { new { collectionId = "sessions" } },
                orderBy = new[] { new { field = new { fieldPath = "lastSeen" }, direction = "DESCENDING" } },
                limit = 20,
            }, $"users/{Fire.Uid}").ContinueWith(t => t.IsFaulted ? new List<(string, JsonNode)>() : t.Result);
            foreach (var (id, f) in sessions)
            {
                var mine = id == mySessionId;
                var seen = Fire.FLong(f, "lastSeen");
                list.Children.Add(new TextBlock
                {
                    Text = $"{Fire.FStr(f, "label")}{(mine ? " — это устройство" : "")}\n   активна {DateTimeOffset.FromUnixTimeMilliseconds(seen == 0 ? Fire.FLong(f, "createdAt") : seen).LocalDateTime:d MMM, HH:mm}",
                    Margin = new Thickness(0, 3, 0, 3), FontSize = 12.5,
                });
            }
            if (list.Children.Count == 0) list.Children.Add(new TextBlock { Text = "Записей нет", Opacity = 0.6, FontSize = 12.5 });

            var events = await Fire.RunQueryAsync(new
            {
                from = new[] { new { collectionId = "seclog" } },
                orderBy = new[] { new { field = new { fieldPath = "at" }, direction = "DESCENDING" } },
                limit = 50,
            }, $"users/{Fire.Uid}").ContinueWith(t => t.IsFaulted ? new List<(string, JsonNode)>() : t.Result);
            foreach (var (_, f) in events)
            {
                var type = Fire.FStr(f, "type");
                var ru = type switch
                {
                    "login" => "Вход на новом устройстве",
                    "logout_all" => "Выход на всех устройствах",
                    "key_backup" => "Создана резервная копия ключа",
                    "key_restore" => "Ключ восстановлен из копии",
                    "dm_closed" => "Личка закрыта",
                    "dm_open" => "Личка открыта",
                    _ => type,
                };
                log.Children.Add(new TextBlock
                {
                    Text = $"{ru}\n   {DateTimeOffset.FromUnixTimeMilliseconds(Fire.FLong(f, "at")).LocalDateTime:d MMM, HH:mm} · {Fire.FStr(f, "platform")}",
                    Margin = new Thickness(0, 3, 0, 3), FontSize = 12.5,
                });
            }
            if (log.Children.Count == 0) log.Children.Add(new TextBlock { Text = "Пока пусто", Opacity = 0.6, FontSize = 12.5 });
        }

        kill.Click += async (_, __) =>
        {
            kill.IsEnabled = false;
            try
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                await Fire.PatchDocAsync($"users/{Fire.Uid}/private/prefs", new Dictionary<string, object?> { ["revokeBefore"] = now });
                // своей сессии двигаем createdAt вперёд, иначе метка выкинет и нас
                await Fire.PatchDocAsync($"users/{Fire.Uid}/sessions/{mySessionId}", new Dictionary<string, object?> { ["createdAt"] = now + 1000 });
                await SecLogAsync("logout_all");
                MessageBox.Show("Остальные устройства выйдут при следующем запуске.", "SandyGram");
                await ReloadAsync();
            }
            catch (Exception ex) { MessageBox.Show(ex is FireException fe ? fe.Ru : ex.Message, "Ошибка"); }
            finally { kill.IsEnabled = true; }
        };

        win.Show();
        await ReloadAsync();
    }

    void LogoutBtn_Click(object sender, RoutedEventArgs e)
    {
        sseCts?.Cancel();
        chatsTimer?.Stop(); msgsTimer?.Stop(); presenceTimer?.Stop();
        Fire.IdToken = Fire.RefreshToken = Fire.Uid = "";
        try { File.Delete(SessionFile); } catch { }
        chats.Clear(); currentChatId = ""; lastMsgSignature = lastListSignature = "";
        loadedMsgs.Clear();
        ChatList.Children.Clear(); MsgList.Children.Clear();
        ChatHeader.Visibility = Visibility.Collapsed;
        Composer.Visibility = Visibility.Collapsed;
        EmptyState.Visibility = Visibility.Visible;
        MainPanel.Visibility = Visibility.Collapsed;
        AuthPanel.Visibility = Visibility.Visible;
    }

    DispatcherTimer StartTimer(double seconds, Func<Task> tick)
    {
        var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(seconds) };
        bool busy = false;
        t.Tick += async (_, _) => { if (busy) return; busy = true; try { await tick(); } catch { } finally { busy = false; } };
        t.Start();
        return t;
    }

    async Task HeartbeatAsync()
    {
        if (string.IsNullOrEmpty(Fire.Uid)) return;
        await Fire.PatchDocAsync($"users/{Fire.Uid}", new() { ["lastSeen"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
    }

    // ---------- сигнальная шина RTDB: слушаем /bump стримом ----------
    void StartBumpListener()
    {
        sseCts?.Cancel();
        sseCts = new System.Threading.CancellationTokenSource();
        var ct = sseCts.Token;
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await Fire.EnsureTokenAsync();
                    using var http = new System.Net.Http.HttpClient { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
                    using var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, $"{Rtdb}/bump.json?auth={Fire.IdToken}");
                    req.Headers.Add("Accept", "text/event-stream");
                    using var resp = await http.SendAsync(req, System.Net.Http.HttpCompletionOption.ResponseHeadersRead, ct);
                    using var stream = await resp.Content.ReadAsStreamAsync(ct);
                    using var reader = new StreamReader(stream);
                    string evt = "";
                    while (!ct.IsCancellationRequested)
                    {
                        var line = await reader.ReadLineAsync(ct);
                        if (line == null) break;
                        if (line.StartsWith("event:")) evt = line[6..].Trim();
                        else if (line.StartsWith("data:") && (evt == "put" || evt == "patch"))
                        {
                            var payload = line[5..].Trim();
                            if (payload == "null") continue;
                            var data = JsonNode.Parse(payload);
                            var path = data?["path"]?.GetValue<string>() ?? "/";
                            var chatId = path.Trim('/');
                            if (chatId.Length > 0 && !chatId.Contains('/'))
                                await Dispatcher.InvokeAsync(() => _ = OnBumpAsync(chatId));
                        }
                        else if (evt == "auth_revoked") break; // токен истёк — переподключаемся с новым
                    }
                }
                catch { }
                try { await Task.Delay(3000, ct); } catch { break; }
            }
        }, ct);
    }

    async Task OnBumpAsync(string chatId)
    {
        try
        {
            var doc = await Fire.GetDocAsync($"chats/{chatId}");
            if (doc?["fields"] == null) return;
            var fields = doc["fields"]!;

            // звук ТОЛЬКО если появилось новое непрочитанное сообщение
            // (и оно не в открытом/активном окне чата)
            long myUnread = 0;
            foreach (var kv in Fire.FMap(fields, "unread"))
                if (kv.Key == Fire.Uid && kv.Value is long u) myUnread = u;
            var bg = chatId != currentChatId || !IsActive;
            var isNew = myUnread > 0 && (!lastSoundUnread.TryGetValue(chatId, out var prev) || myUnread > prev);
            lastSoundUnread[chatId] = myUnread;
            if (bg && isNew)
                try { System.Media.SystemSounds.Asterisk.Play(); } catch { }

            if (chatId == currentChatId) await PollMessagesAsync(); // дельта: только новые
            // обновляем одну строку списка (1 чтение), а не весь список
            chats[chatId] = fields;
            lastListSignature = "";
            await RenderChatListAsync();
            if (chatId == currentChatId && loadedMsgs.Count > 0)
            {
                long lro = 0;
                foreach (var kv in Fire.FMap(fields, "lastRead"))
                    if (kv.Key != Fire.Uid && kv.Value is long lr && lr > lro) lro = lr;
                if (lro != lastTicksMark) RenderMessages(); // галочки «прочитано»
            }
        }
        catch { }
    }

    // ================================================================ чаты
    async Task PollChatsAsync()
    {
        var rows = await Fire.RunQueryAsync(new
        {
            from = new[] { new { collectionId = "chats" } },
            where = new { fieldFilter = new { field = new { fieldPath = "members" }, op = "ARRAY_CONTAINS", value = new { stringValue = Fire.Uid } } },
            limit = 100,
        });
        chats.Clear();
        foreach (var (id, fields) in rows) chats[id] = fields;
        await RenderChatListAsync();
        if (!string.IsNullOrEmpty(currentChatId) && chats.TryGetValue(currentChatId, out var cf))
        {
            long lro = 0;
            foreach (var kv in Fire.FMap(cf, "lastRead"))
                if (kv.Key != Fire.Uid && kv.Value is long lr && lr > lro) lro = lr;
            if (lro != lastTicksMark && loadedMsgs.Count > 0) RenderMessages();
        }
    }

    async Task<JsonNode?> GetUserCachedAsync(string uid)
    {
        if (userCache.TryGetValue(uid, out var u) && userCacheAt.TryGetValue(uid, out var at) && (DateTime.UtcNow - at).TotalSeconds < 30)
            return u;
        var doc = await Fire.GetDocAsync($"users/{uid}");
        if (doc?["fields"] != null) { userCache[uid] = doc["fields"]!; userCacheAt[uid] = DateTime.UtcNow; return doc["fields"]; }
        return userCache.TryGetValue(uid, out var stale) ? stale : null;
    }

    async Task<(string Title, string AvatarLetter, string Tone, string? Photo, string Sub)> ChatViewAsync(string id, JsonNode f)
    {
        var type = Fire.FStr(f, "type");
        if (type == "saved") return ("Избранное", "☆", "#F5F5F5", null, "ваши заметки");
        if (type == "private")
        {
            var peerUid = Fire.FList(f, "members").Select(m => m as string).FirstOrDefault(m => m != Fire.Uid) ?? "";
            var peer = await GetUserCachedAsync(peerUid);
            if (peer == null) return ("…", "?", AvatarTones[0], null, "");
            var name = Fire.FStr(peer, "displayName");
            var tone = AvatarTones[Math.Abs((int)Fire.FLong(peer, "avatarColor")) % 7];
            var hide = Fire.F(peer, "hideLastSeen") as bool? ?? false;
            var lastSeen = Fire.FLong(peer, "lastSeen");
            var online = !hide && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - lastSeen < 70_000;
            var sub = hide ? "был(а) недавно" : online ? "в сети" : "был(а) недавно";
            return (name, name.Length > 0 ? name[..1].ToUpper() : "?", tone, Fire.FStr(peer, "avatar") is { Length: > 0 } a ? a : null, sub);
        }
        var title = Fire.FStr(f, "title");
        var count = Fire.FList(f, "members").Count;
        var kind = type == "channel" ? $"📢 канал · {count} подписчик(ов)" : $"{count} участник(ов)";
        return (title, title.Length > 0 ? title[..1].ToUpper() : "?", AvatarTones[Math.Abs((int)Fire.FLong(f, "avatarColor")) % 7], null, kind);
    }

    async Task RenderChatListAsync()
    {
        var ordered = chats.OrderByDescending(kv =>
        {
            var lm = Fire.FMap(kv.Value, "lastMessage");
            return lm.TryGetValue("createdAt", out var c) && c is long l ? l : Fire.FLong(kv.Value, "createdAt");
        }).ToList();

        var sig = string.Join("|", ordered.Select(kv =>
        {
            var lm = Fire.FMap(kv.Value, "lastMessage");
            var unread = Fire.FMap(kv.Value, "unread").TryGetValue(Fire.Uid, out var u) && u is long ul ? ul : 0;
            return $"{kv.Key}:{(lm.TryGetValue("createdAt", out var c) ? c : 0)}:{(lm.TryGetValue("text", out var t) ? t : "")}:{unread}:{kv.Key == currentChatId}";
        }));
        if (sig == lastListSignature) return;
        lastListSignature = sig;

        long totalUnread = 0;
        foreach (var kv in chats)
            if (Fire.FMap(kv.Value, "unread").TryGetValue(Fire.Uid, out var uu) && uu is long ul2) totalUnread += ul2;
        Title = totalUnread > 0 ? $"SandyGram ({totalUnread})" : "SandyGram";

        ChatList.Children.Clear();
        foreach (var (id, f) in ordered)
        {
            var (title, letter, tone, photo, _) = await ChatViewAsync(id, f);
            if (searchFilter.Length > 0 && !title.ToLowerInvariant().Contains(searchFilter)) continue;
            var lm = Fire.FMap(f, "lastMessage");
            var preview = lm.TryGetValue("text", out var pt) && pt is string ps && ps.Length > 0 ? ps
                : lm.TryGetValue("hasImage", out var hi) && hi is bool hb && hb ? "📷 Фото" : "Нет сообщений";
            var unread = Fire.FMap(f, "unread").TryGetValue(Fire.Uid, out var un) && un is long unl ? unl : 0;

            var row = new Border
            {
                Style = (Style)FindResource("ChatRow"),
                Padding = new Thickness(10, 9, 10, 9),
                Margin = new Thickness(0, 1, 0, 1),
            };
            if (id == currentChatId) row.Background = (Brush)FindResource("Surface3");
            var g = new Grid();
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            g.Children.Add(MakeAvatar(letter, tone, photo, 42));

            var textCol = new StackPanel { Margin = new Thickness(10, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
            textCol.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.Bold, FontSize = 14, Foreground = (Brush)FindResource("Text"), TextTrimming = TextTrimming.CharacterEllipsis });
            textCol.Children.Add(new TextBlock { Text = preview, FontSize = 12, Foreground = (Brush)FindResource("Muted"), TextTrimming = TextTrimming.CharacterEllipsis });
            Grid.SetColumn(textCol, 1);
            g.Children.Add(textCol);

            if (unread > 0)
            {
                var badge = new Border
                {
                    Background = (Brush)FindResource("Inverse"), CornerRadius = new CornerRadius(99),
                    MinWidth = 22, Height = 22, VerticalAlignment = VerticalAlignment.Center, Padding = new Thickness(6, 0, 6, 0),
                };
                badge.Child = new TextBlock { Text = unread.ToString(), FontSize = 11, FontWeight = FontWeights.Bold, Foreground = (Brush)FindResource("OnInverse"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(badge, 2);
                g.Children.Add(badge);
            }

            row.Child = g;
            var chatId = id;
            row.MouseLeftButtonUp += async (_, _) => await OpenChatAsync(chatId);
            ChatList.Children.Add(row);
        }
    }

    UIElement MakeAvatar(string letter, string tone, string? photo, double size)
    {
        var b = new Border
        {
            Width = size, Height = size, CornerRadius = new CornerRadius(size / 2),
            Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString(tone)),
            VerticalAlignment = VerticalAlignment.Center, ClipToBounds = true,
        };
        if (photo != null)
        {
            var img = TryImage(photo, size);
            if (img != null)
            {
                b.Background = new ImageBrush(img) { Stretch = Stretch.UniformToFill };
                return b;
            }
        }
        b.Child = new TextBlock
        {
            Text = letter, FontWeight = FontWeights.Bold, FontSize = size * 0.42,
            Foreground = tone is "#F5F5F5" or "#F3EDFF" or "#E8DDFD" or "#DCCFFB" or "#CFC0F8" or "#C2B1F4" or "#B5A2F0" or "#A893EC" ? (Brush)FindResource("OnInverse") : Brushes.White,
            HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center,
        };
        return b;
    }

    static BitmapImage? TryImage(string src, double decodeSize = 0)
    {
        try
        {
            var img = new BitmapImage();
            img.BeginInit();
            img.CacheOption = BitmapCacheOption.OnLoad;
            if (decodeSize > 0) img.DecodePixelWidth = (int)(decodeSize * 2);
            if (src.StartsWith("data:"))
            {
                var b64 = src[(src.IndexOf(",") + 1)..];
                img.StreamSource = new MemoryStream(Convert.FromBase64String(b64));
            }
            else img.UriSource = new Uri(src);
            img.EndInit();
            return img;
        }
        catch { return null; }
    }

    // ================================================================ переписка
    bool IsForumChat(JsonNode f) => Fire.FList(f, "topics").Count > 0;

    TextBlock MakeMessageText(string text, Brush fg, bool mine)
    {
        var tb = new TextBlock { FontSize = 13.5, Foreground = fg, TextWrapping = TextWrapping.Wrap };
        var linkBrush = mine ? (Brush)FindResource("OnInverse") : (Brush)FindResource("Inverse");
        var cursor = 0;
        var rx = new System.Text.RegularExpressions.Regex(@"https?://[^\s<]+");
        foreach (System.Text.RegularExpressions.Match mm in rx.Matches(text))
        {
            if (mm.Index > cursor) AddStyledRuns(tb, text[cursor..mm.Index], fg);
            var u = System.Text.RegularExpressions.Regex.Replace(mm.Value, "[.,;:!?)]+$", "");
            var invite = System.Text.RegularExpressions.Regex.Match(u, @"^https?://(?:sandygram-a3b42\.web\.app|localhost(?::\d+)?)/join/([a-f0-9]{6,})$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            var h = new Hyperlink { Foreground = linkBrush, TextDecorations = TextDecorations.Underline };
            if (invite.Success)
            {
                var code = invite.Groups[1].Value;
                h.Inlines.Add(new Run("🤝 Вступить по ссылке"));
                h.Click += async (_, _) => await JoinInviteAsync(code);
            }
            else
            {
                h.Inlines.Add(new Run(u));
                h.NavigateUri = new Uri(u);
                h.RequestNavigate += (_, e) => Process.Start(new System.Diagnostics.ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true });
            }
            tb.Inlines.Add(h);
            cursor = mm.Index + mm.Length;
        }
        if (cursor < text.Length) AddStyledRuns(tb, text[cursor..], fg);
        return tb;
    }

    // 3.0: разметка — ```блок```, `код`, ||спойлер||, **жирный**, *курсив*, ~~зачёркнутый~~.
    // Текст остаётся текстом: собираем Run-ы, никакой разбор вёрстки здесь невозможен.
    static readonly System.Text.RegularExpressions.Regex MdRx = new(
        @"(```[\s\S]*?```|`[^`\n]+`|\|\|[\s\S]+?\|\||\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~)");
    void AddStyledRuns(TextBlock tb, string s, Brush fg)
    {
        var pos = 0;
        foreach (System.Text.RegularExpressions.Match m in MdRx.Matches(s))
        {
            if (m.Index > pos) tb.Inlines.Add(new Run(s[pos..m.Index]));
            var tok = m.Value;
            if (tok.StartsWith("```"))
                tb.Inlines.Add(new Run(tok[3..^3].TrimStart('\r', '\n').TrimEnd()) { FontFamily = new FontFamily("Consolas") });
            else if (tok.StartsWith("||"))
            {
                // спойлер: замазан цветом текста, открывается кликом и обратно не закрывается
                var inner = new Run(tok[2..^2]) { Background = fg, Foreground = fg };
                var link = new Hyperlink(inner) { TextDecorations = null, Foreground = fg, ToolTip = "Нажмите, чтобы показать" };
                link.Click += (_, _) => { inner.Background = null; inner.Foreground = fg; };
                tb.Inlines.Add(link);
            }
            else if (tok.StartsWith("**")) tb.Inlines.Add(new Run(tok[2..^2]) { FontWeight = FontWeights.Bold });
            else if (tok.StartsWith("~~")) tb.Inlines.Add(new Run(tok[2..^2]) { TextDecorations = TextDecorations.Strikethrough });
            else if (tok.StartsWith("`")) tb.Inlines.Add(new Run(tok[1..^1]) { FontFamily = new FontFamily("Consolas") });
            else tb.Inlines.Add(new Run(tok[1..^1]) { FontStyle = FontStyles.Italic });
            pos = m.Index + m.Length;
        }
        if (pos < s.Length) tb.Inlines.Add(new Run(s[pos..]));
    }

    async Task JoinInviteAsync(string code)
    {
        try
        {
            var doc = await Fire.GetDocAsync($"invites/{code}");
            if (doc?["fields"] == null) { MessageBox.Show("Ссылка недействительна или отозвана.", "SandyGram", MessageBoxButton.OK, MessageBoxImage.Information); return; }
            var fields = doc["fields"]!;
            var chatId = Fire.FStr(fields, "chatId");
            if (string.IsNullOrEmpty(chatId)) return;
            var title = Fire.FStr(fields, "title");
            var already = Fire.FList(fields, "members").Contains(Fire.Uid);
            var res = MessageBox.Show($"Войти в чат «{title}»?", "SandyGram", MessageBoxButton.OKCancel, MessageBoxImage.Question);
            if (res != MessageBoxResult.OK) return;
            if (!already)
            {
                var chatDoc = await Fire.GetDocAsync($"chats/{chatId}");
                var cur = Fire.FList(chatDoc?["fields"] ?? new JsonObject(), "members").Select(x => x as string ?? "").ToList();
                if (!cur.Contains(Fire.Uid)) cur.Add(Fire.Uid);
                await Fire.PatchDocAsync($"chats/{chatId}", new Dictionary<string, object?> { ["members"] = cur }, new[] { "members" });
            }
            await OpenChatAsync(chatId);
        }
        catch (Exception) { MessageBox.Show("Не удалось войти по ссылке.", "SandyGram", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    async Task OpenChatAsync(string chatId)
    {
        if (!string.IsNullOrEmpty(currentChatId) && currentChatId != chatId)
        {
            if (MsgInput.Text.Trim().Length > 0) drafts[currentChatId] = MsgInput.Text;
            else drafts.Remove(currentChatId);
        }
        MsgInput.Text = drafts.TryGetValue(chatId, out var d) ? d : "";
        currentTopicId = "";
        TopicBackBtn.Visibility = Visibility.Collapsed;
        replyTo = null; replyTargetUid = ""; ReplyBar.Visibility = Visibility.Collapsed;
        currentChatId = chatId;
        lastMsgSignature = ""; lastListSignature = "";
        loadedMsgs.Clear(); lastMaxCreated = 0;
        MentionBox.Visibility = Visibility.Collapsed;
        _ = LoadMentionPoolAsync();
        MsgList.Children.Clear();
        if (!chats.TryGetValue(chatId, out var f)) return;
        var (title, letter, tone, photo, sub) = await ChatViewAsync(chatId, f);
        ChatTitle.Text = title;
        ChatSubtitle.Text = sub;
        ChatAvatar.Content = MakeAvatar(letter, tone, photo, 42);
        ChatHeader.Visibility = Visibility.Visible;
        EmptyState.Visibility = Visibility.Collapsed;

        // канал: пишут только админы; форум: сначала список топиков
        var type = Fire.FStr(f, "type");
        var admins = Fire.FList(f, "admins").Select(a => a as string).ToList();
        var isAdmin = Fire.FStr(f, "ownerUid") == Fire.Uid || admins.Contains(Fire.Uid);
        var forum = IsForumChat(f);
        Composer.Visibility = (type == "channel" && !isAdmin) || forum ? Visibility.Collapsed : Visibility.Visible;

        await RenderChatListAsync();
        await PollMessagesAsync(force: true);
        if (forum) RenderTopicList();
        await MarkReadAsync(chatId);
        MsgInput.Focus();
    }

    async Task MarkReadAsync(string chatId)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await Fire.PatchDocAsync($"chats/{chatId}", new()
        {
            ["lastRead"] = new Dictionary<string, object?> { [Fire.Uid] = now },
            ["unread"] = new Dictionary<string, object?> { [Fire.Uid] = 0L },
        }, new[] { $"lastRead.{Bq(Fire.Uid)}", $"unread.{Bq(Fire.Uid)}" });
        _ = BumpAsync(chatId); // мгновенные галочки у собеседника
    }

    static async Task BumpAsync(string chatId)
    {
        try
        {
            await Fire.EnsureTokenAsync();
            using var http = new System.Net.Http.HttpClient();
            await http.PutAsync($"{Rtdb}/bump/{Uri.EscapeDataString(chatId)}.json?auth={Fire.IdToken}",
                new System.Net.Http.StringContent(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString()));
        }
        catch { }
    }

    async Task PollMessagesAsync(bool force = false)
    {
        if (string.IsNullOrEmpty(currentChatId)) return;
        if (force || loadedMsgs.Count == 0)
        {
            // первая загрузка: последние 100 сообщений
            var all = await QueryMessagesAsync(sinceMs: 0, limitN: 100, desc: true);
            all.Reverse();
            loadedMsgs.Clear();
            loadedMsgs.AddRange(all);
            lastMaxCreated = loadedMsgs.Count > 0 ? loadedMsgs.Max(r => Fire.FLong(r.Fields, "createdAt")) : 0;
            RenderMessages(scrollBottom: true);
            return;
        }
        // дельта: только новые сообщения (пустой ответ ≈ 1 чтение из квоты)
        var fresh = await QueryMessagesAsync(sinceMs: lastMaxCreated, limitN: 50, desc: false);
        if (fresh.Count == 0) return;
        foreach (var row in fresh)
            if (!loadedMsgs.Any(x => x.Id == row.Id)) loadedMsgs.Add(row);
        lastMaxCreated = Math.Max(lastMaxCreated, fresh.Max(r => Fire.FLong(r.Fields, "createdAt")));
        RenderMessages(scrollBottom: true);
        if (fresh.Any(r => Fire.FStr(r.Fields, "sender") != Fire.Uid) && IsActive)
            await MarkReadAsync(currentChatId);
    }

    void RenderTopicList()
    {
        if (!chats.TryGetValue(currentChatId, out var f)) return;
        currentTopicId = "";
        TopicBackBtn.Visibility = Visibility.Collapsed;
        Composer.Visibility = Visibility.Collapsed;
        ChatSubtitle.Text = "выберите топик";
        MsgList.Children.Clear();
        var topics = new List<Dictionary<string, object?>> { new() { ["id"] = "general", ["title"] = "Общий", ["icon"] = "#" } };
        foreach (var t in Fire.FList(f, "topics"))
            if (t is Dictionary<string, object?> td) topics.Add(td);
        foreach (var t in topics)
        {
            var tid = t.TryGetValue("id", out var ti) ? ti as string ?? "general" : "general";
            var title = t.TryGetValue("title", out var tt) ? tt as string ?? "" : "";
            var icon = t.TryGetValue("icon", out var tic) ? tic as string ?? "#" : "#";
            var closed = t.TryGetValue("closed", out var tc) && tc is bool cb && cb;
            var row = new Border { Style = (Style)FindResource("ChatRow"), Padding = new Thickness(12, 10, 12, 10), Margin = new Thickness(0, 2, 0, 2) };
            var g = new Grid();
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var iconBox = new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(11), Background = (Brush)FindResource("Surface2") };
            iconBox.Child = new TextBlock { Text = icon, FontSize = 18, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            g.Children.Add(iconBox);
            var tb = new TextBlock { Text = title + (closed ? "  🔒" : ""), FontWeight = FontWeights.Bold, FontSize = 14, Foreground = (Brush)FindResource("Text"), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0) };
            Grid.SetColumn(tb, 1);
            g.Children.Add(tb);
            row.Child = g;
            var topicId = tid; var topicTitle = title; var topicClosed = closed;
            row.MouseLeftButtonUp += (_, _) => EnterTopic(topicId, topicTitle, topicClosed);
            MsgList.Children.Add(row);
        }
    }

    void EnterTopic(string topicId, string title, bool closed)
    {
        currentTopicId = topicId;
        TopicBackBtn.Visibility = Visibility.Visible;
        ChatSubtitle.Text = "# " + title;
        var isAdmin = false;
        if (chats.TryGetValue(currentChatId, out var f))
            isAdmin = Fire.FStr(f, "ownerUid") == Fire.Uid || Fire.FList(f, "admins").Any(a => a as string == Fire.Uid);
        Composer.Visibility = closed && !isAdmin ? Visibility.Collapsed : Visibility.Visible;
        RenderMessages(scrollBottom: true);
        MsgInput.Focus();
    }

    void TopicBackBtn_Click(object sender, RoutedEventArgs e) => RenderTopicList();

    void RenderMessages(bool scrollBottom = false)
    {
        long lastReadByOthers = 0;
        var isGroup = false;
        if (chats.TryGetValue(currentChatId, out var chatFields))
        {
            foreach (var kv in Fire.FMap(chatFields, "lastRead"))
                if (kv.Key != Fire.Uid && kv.Value is long lr && lr > lastReadByOthers) lastReadByOthers = lr;
            isGroup = Fire.FStr(chatFields, "type") is "group" or "channel";
        }
        lastTicksMark = lastReadByOthers;

        var forum = chatFields != null && IsForumChat(chatFields);
        if (forum && currentTopicId.Length == 0) { RenderTopicList(); return; }
        var wasAtBottom = MsgScroll.VerticalOffset >= MsgScroll.ScrollableHeight - 60;
        MsgList.Children.Clear();
        string lastDay = "";
        foreach (var (id, m) in loadedMsgs.OrderBy(r => Fire.FLong(r.Fields, "createdAt")))
        {
            if (Fire.F(m, "deleted") is bool d && d) continue;
            // 3.0: просроченные исчезающие и уже просмотренные одноразовые не показываем
            var exp = Fire.FLong(m, "expiresAt");
            if (exp > 0 && exp <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) continue;
            if (Fire.F(m, "viewOnce") is bool vOnce && vOnce && Fire.FMap(m, "viewedBy").Count > 0) continue;
            if (forum)
            {
                var mt = Fire.FStr(m, "topicId");
                if ((mt.Length == 0 ? "general" : mt) != currentTopicId) continue;
            }
            var created = Fire.FLong(m, "createdAt");
            var day = DateTimeOffset.FromUnixTimeMilliseconds(created).ToLocalTime().ToString("d MMMM");
            if (day != lastDay)
            {
                lastDay = day;
                var chip = new Border
                {
                    Background = (Brush)FindResource("Surface"), CornerRadius = new CornerRadius(11),
                    Padding = new Thickness(12, 4, 12, 4), HorizontalAlignment = HorizontalAlignment.Center,
                    Margin = new Thickness(0, 12, 0, 8),
                };
                chip.Child = new TextBlock { Text = day, Foreground = (Brush)FindResource("Muted"), FontSize = 11 };
                MsgList.Children.Add(chip);
            }
            MsgList.Children.Add(BuildBubble(id, m, isGroup, lastReadByOthers));
        }
        if (scrollBottom || wasAtBottom) MsgScroll.ScrollToBottom();
    }

    async Task<List<(string Id, JsonNode Fields)>> QueryMessagesAsync(long sinceMs, int limitN, bool desc)
    {
        await Fire.EnsureTokenAsync();
        var url = $"https://firestore.googleapis.com/v1/projects/{Fire.Project}/databases/(default)/documents/chats/{currentChatId}:runQuery";
        var req = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Post, url);
        req.Headers.Add("Authorization", $"Bearer {Fire.IdToken}");
        object structuredQuery = sinceMs > 0
            ? new
            {
                from = new[] { new { collectionId = "messages" } },
                where = new { fieldFilter = new { field = new { fieldPath = "createdAt" }, op = "GREATER_THAN", value = new { integerValue = sinceMs.ToString() } } },
                orderBy = new[] { new { field = new { fieldPath = "createdAt" }, direction = desc ? "DESCENDING" : "ASCENDING" } },
                limit = limitN,
            }
            : new
            {
                from = new[] { new { collectionId = "messages" } },
                orderBy = new[] { new { field = new { fieldPath = "createdAt" }, direction = desc ? "DESCENDING" : "ASCENDING" } },
                limit = limitN,
            };
        req.Content = System.Net.Http.Json.JsonContent.Create(new { structuredQuery });
        using var http = new System.Net.Http.HttpClient();
        var resp = await http.SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        var arr = JsonNode.Parse(text) as JsonArray ?? new JsonArray();
        var list = new List<(string, JsonNode)>();
        foreach (var row in arr)
        {
            var doc = row?["document"];
            if (doc == null) continue;
            var name = doc["name"]!.GetValue<string>();
            list.Add((name[(name.LastIndexOf('/') + 1)..], doc["fields"] ?? new JsonObject()));
        }
        return list;
    }

    UIElement BuildBubble(string id, JsonNode m, bool isGroup, long lastReadByOthers)
    {
        var mine = Fire.FStr(m, "sender") == Fire.Uid;
        var bubble = new Border
        {
            CornerRadius = new CornerRadius(18, 18, mine ? 6 : 18, mine ? 18 : 6),
            Background = mine ? (Brush)FindResource("Inverse") : (Brush)FindResource("Surface"),
            Padding = new Thickness(13, 8, 13, 8),
            HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            MaxWidth = 540, Margin = new Thickness(0, 2, 0, 2),
        };
        var fg = mine ? (Brush)FindResource("OnInverse") : (Brush)FindResource("Text");
        var stack = new StackPanel();

        if (isGroup && !mine)
            stack.Children.Add(new TextBlock { Text = Fire.FStr(m, "senderName"), FontSize = 11.5, FontWeight = FontWeights.Bold, Foreground = (Brush)FindResource("Muted"), Margin = new Thickness(0, 0, 0, 2) });

        if (Fire.FStr(m, "forwardedFrom") is { Length: > 0 } fwd)
            stack.Children.Add(new TextBlock { Text = $"Переслано от {fwd}", FontSize = 11.5, FontStyle = FontStyles.Italic, Foreground = fg, Opacity = 0.7 });

        var reply = Fire.FMap(m, "replyTo");
        if (reply.Count > 0)
        {
            var q = new Border { BorderBrush = fg, BorderThickness = new Thickness(2, 0, 0, 0), Padding = new Thickness(7, 0, 0, 0), Margin = new Thickness(0, 0, 0, 4), Opacity = 0.75 };
            var qs = new StackPanel();
            qs.Children.Add(new TextBlock { Text = reply.TryGetValue("sender", out var rs) ? rs as string : "", FontSize = 11.5, FontWeight = FontWeights.Bold, Foreground = fg });
            qs.Children.Add(new TextBlock { Text = reply.TryGetValue("text", out var rt) ? rt as string : "", FontSize = 11.5, Foreground = fg, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 420 });
            q.Child = qs;
            stack.Children.Add(q);
        }

        // 3.0: одноразовое сообщение — на Windows только предупреждение, открывать тут нельзя,
        // иначе отметка о просмотре сгорит без показа содержимого пользователю.
        var viewOnce = Fire.F(m, "viewOnce") is bool vo1 && vo1;
        if (viewOnce)
            stack.Children.Add(new TextBlock { Text = "👁 Одноразовое сообщение — откройте в телефоне или в браузере", FontSize = 12.5, Foreground = fg, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 4) });

        // 3.0: медиа лежит в R2, показываем картинку либо карточку файла со ссылкой
        var media = Fire.FMap(m, "media");
        if (!viewOnce && media.Count > 0)
        {
            var mUrl = media.TryGetValue("url", out var mu) ? mu as string ?? "" : "";
            var mKind = media.TryGetValue("kind", out var mk) ? mk as string ?? "file" : "file";
            var mName = media.TryGetValue("name", out var mn) ? mn as string ?? "Файл" : "Файл";
            var mSize = media.TryGetValue("size", out var ms) && ms is long sl ? sl : 0L;
            if (mKind == "image" && TryImage(mUrl) is { } mediaImg)
                stack.Children.Add(new Image { Source = mediaImg, MaxWidth = 320, MaxHeight = 320, Stretch = Stretch.Uniform, Margin = new Thickness(0, 2, 0, 4) });
            else if (mUrl.Length > 0)
            {
                var icon = mKind == "video" ? "🎬" : mKind == "audio" ? "🎵" : "📎";
                var sizeText = mSize > 0 ? $" · {(mSize < 1024 * 1024 ? $"{mSize / 1024} КБ" : $"{mSize / 1024.0 / 1024.0:0.#} МБ")}" : "";
                var fb = new Button
                {
                    Style = (Style)FindResource(mine ? "GhostBtn" : "PrimaryBtn"),
                    Content = $"{icon}  {mName}{sizeText}", FontSize = 12,
                    Padding = new Thickness(12, 7, 12, 7), Margin = new Thickness(0, 2, 0, 4),
                    HorizontalAlignment = HorizontalAlignment.Left,
                };
                    fb.Click += (_, _) => { try { Process.Start(new System.Diagnostics.ProcessStartInfo(mUrl) { UseShellExecute = true }); } catch { } };
                stack.Children.Add(fb);
            }
        }

        // 3.0: мини-игра — на Windows только счёт-заглушка, ходить можно в вебе и на телефоне
        var game = Fire.FMap(m, "game");
        if (game.Count > 0)
        {
            var board = game.TryGetValue("board", out var gb) ? gb as string ?? "---------" : "---------";
            if (board.Length != 9) board = "---------"; // чужой формат — не падаем
            var rows = new[] { board.Substring(0, 3), board.Substring(3, 3), board.Substring(6, 3) };
            stack.Children.Add(new TextBlock
            {
                Text = "🎮 Крестики-нолики\n" + string.Join("\n", rows).Replace("-", "·"),
                FontFamily = new FontFamily("Consolas"), FontSize = 15, Foreground = fg,
                Margin = new Thickness(0, 2, 0, 4),
            });
        }

        // 3.0: бросок кубика — результат считает отправитель, мы только показываем
        var dice = Fire.FMap(m, "dice");
        if (dice.Count > 0)
        {
            var val = dice.TryGetValue("value", out var dv) ? Convert.ToString(dv) : "?";
            var sides = dice.TryGetValue("sides", out var ds) ? Convert.ToString(ds) : "6";
            stack.Children.Add(new TextBlock
            {
                Text = $"🎲 {val}  (из {sides})",
                FontSize = 20, FontWeight = FontWeights.Bold, Foreground = fg,
                Margin = new Thickness(0, 2, 0, 4),
            });
        }

        if (Fire.FStr(m, "image") is { Length: > 0 } imgSrc && !viewOnce && TryImage(imgSrc) is { } bmp)
            stack.Children.Add(new Image { Source = bmp, MaxWidth = 320, MaxHeight = 320, Stretch = Stretch.Uniform, Margin = new Thickness(0, 2, 0, 4) });

        if (Fire.FStr(m, "sticker") is { Length: > 0 } sticker && TryImage($"{Site}/stickers/{sticker}.png") is { } stImg)
            stack.Children.Add(new Image { Source = stImg, Width = 130, Height = 130, Margin = new Thickness(0, 2, 0, 2) });

        var voice = Fire.FMap(m, "voice");
        if (voice.Count > 0)
        {
            var vb = new Button { Style = (Style)FindResource(mine ? "GhostBtn" : "PrimaryBtn"), Content = $"▶  Голосовое · {(voice.TryGetValue("duration", out var dur) ? dur : 0)} сек", FontSize = 12, Padding = new Thickness(12, 7, 12, 7), Margin = new Thickness(0, 2, 0, 4), HorizontalAlignment = HorizontalAlignment.Left };
            var data = voice.TryGetValue("data", out var vd) ? vd as string : null;
            vb.Click += (_, _) => PlayVoice(data);
            stack.Children.Add(vb);
        }

        var poll = Fire.FMap(m, "poll");
        if (poll.Count > 0)
        {
            var pStack = new StackPanel { Margin = new Thickness(0, 4, 0, 2), MinWidth = 220 };
            pStack.Children.Add(new TextBlock { Text = "📊 " + (poll.TryGetValue("question", out var pq) ? pq as string : ""), FontWeight = FontWeights.Bold, Foreground = fg, Margin = new Thickness(0, 0, 0, 6), TextWrapping = TextWrapping.Wrap });
            var votes = poll.TryGetValue("votes", out var vv) && vv is Dictionary<string, object?> vd ? vd : new Dictionary<string, object?>();
            var total = votes.Count;
            if (poll.TryGetValue("options", out var oo) && oo is List<object?> opts)
                foreach (var optObj in opts)
                {
                    if (optObj is not Dictionary<string, object?> opt) continue;
                    var oid = (opt.TryGetValue("id", out var oi) ? oi as string : "") ?? "";
                    var otxt = (opt.TryGetValue("text", out var ot) ? ot as string : "") ?? "";
                    var cnt = votes.Values.Count(x => x as string == oid);
                    var pct = total > 0 ? (int)Math.Round(cnt * 100.0 / total) : 0;
                    var myVote = votes.TryGetValue(Fire.Uid, out var mv) && mv as string == oid;
                    var optBtn = new Border { BorderBrush = fg, BorderThickness = new Thickness(myVote ? 2 : 1), CornerRadius = new CornerRadius(10), Padding = new Thickness(10, 6, 10, 6), Margin = new Thickness(0, 0, 0, 5), Cursor = Cursors.Hand, Opacity = myVote ? 1 : 0.85 };
                    var g2 = new Grid();
                    g2.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    g2.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    g2.Children.Add(new TextBlock { Text = otxt, Foreground = fg, FontSize = 13, TextWrapping = TextWrapping.Wrap });
                    var pctTb = new TextBlock { Text = total > 0 ? pct + "%" : "", Foreground = fg, FontWeight = FontWeights.Bold, FontSize = 12, Margin = new Thickness(8, 0, 0, 0) };
                    Grid.SetColumn(pctTb, 1);
                    g2.Children.Add(pctTb);
                    optBtn.Child = g2;
                    var msgId = id; var optId = oid;
                    var cur = votes.TryGetValue(Fire.Uid, out var c2) ? c2 as string : null;
                    optBtn.MouseLeftButtonUp += async (_, _) => await VotePollAsync(msgId, optId, cur == optId);
                    pStack.Children.Add(optBtn);
                }
            pStack.Children.Add(new TextBlock { Text = total > 0 ? $"Голосов: {total}" : "Будьте первым — голосуйте!", Foreground = fg, FontSize = 10.5, Opacity = 0.65 });
            stack.Children.Add(pStack);
        }

        // 3.0: секретный чат — расшифровать на Windows нельзя, ключей тут нет
        if (Fire.FMap(m, "enc").Count > 0)
            stack.Children.Add(MakeMessageText("🔒 Секретное сообщение — читается в приложении и в браузере", fg, mine));
        else if (Fire.FStr(m, "text") is { Length: > 0 } text)
            stack.Children.Add(MakeMessageText(text, fg, mine));

        var created = Fire.FLong(m, "createdAt");
        var meta = DateTimeOffset.FromUnixTimeMilliseconds(created).ToLocalTime().ToString("HH:mm");
        // 3.0: исчезающие сообщения — показываем, что у сообщения есть срок
        var expiresAt = Fire.FLong(m, "expiresAt");
        if (expiresAt > 0) meta = "🔥 " + meta;
        if (Fire.FLong(m, "editedAt") > 0) meta = "изм. " + meta;
        if (mine) meta += lastReadByOthers >= created ? "  ✓✓" : "  ✓";
        stack.Children.Add(new TextBlock { Text = meta, FontSize = 9.5, Foreground = fg, Opacity = 0.6, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 2, 0, 0) });

        // реакции
        var reactions = Fire.FMap(m, "reactions");
        if (reactions.Count > 0)
        {
            var wrap = new WrapPanel { Margin = new Thickness(0, 3, 0, 0) };
            foreach (var kv in reactions)
                if (kv.Value is List<object?> users && users.Count > 0)
                {
                    var chip = new Border { Background = (Brush)FindResource("Surface"), CornerRadius = new CornerRadius(99), Padding = new Thickness(7, 2, 7, 2), Margin = new Thickness(0, 0, 4, 0) };
                    chip.Child = new TextBlock { Text = $"{kv.Key} {users.Count}", FontSize = 11, Foreground = (Brush)FindResource("Text") };
                    wrap.Children.Add(chip);
                }
            stack.Children.Add(wrap);
        }

        bubble.Child = stack;

        // даблклик = ❤️, правый клик = меню
        var msgId2 = id;
        bubble.MouseLeftButtonDown += (_, e2) => { if (e2.ClickCount == 2) _ = ToggleReactionAsync(msgId2, "❤️"); };
        var menu = new ContextMenu();
        var miReply = new MenuItem { Header = "↩ Ответить" };
        var senderName = Fire.FStr(m, "senderName");
        var msgText = Fire.FStr(m, "text");
        miReply.Click += (_, _) =>
        {
            replyTo = (msgId2, senderName, msgText.Length > 120 ? msgText[..120] : (msgText.Length > 0 ? msgText : "📷 Фото"));
            replyTargetUid = Fire.FStr(m, "sender");
            ReplyTitle.Text = "Ответ: " + senderName;
            ReplyText.Text = replyTo.Value.Text;
            ReplyBar.Visibility = Visibility.Visible;
            MsgInput.Focus();
        };
        menu.Items.Add(miReply);
        var miCopy = new MenuItem { Header = "⧉ Копировать" };
        miCopy.Click += (_, _) => { try { Clipboard.SetText(msgText); } catch { } };
        menu.Items.Add(miCopy);
        foreach (var emoji in new[] { "❤️", "👍", "🔥", "😂" })
        {
            var mi = new MenuItem { Header = emoji + " Реакция" };
            var em = emoji;
            mi.Click += (_, _) => _ = ToggleReactionAsync(msgId2, em);
            menu.Items.Add(mi);
        }
        // 3.0: остальные реакции — подменю, чтобы не раздувать основное меню
        var miMore = new MenuItem { Header = "😀 Другая реакция" };
        foreach (var emoji in new[] { "👎", "😮", "😢", "😡", "🎉", "🙏", "👏", "💯", "🤔", "🤯", "🥳", "😍",
                                      "😎", "🤡", "💩", "👀", "💪", "🤝", "✅", "❌", "⚡", "🏆", "🤣", "🫡" })
        {
            var mi = new MenuItem { Header = emoji };
            var em = emoji;
            mi.Click += (_, _) => _ = ToggleReactionAsync(msgId2, em);
            miMore.Items.Add(mi);
        }
        menu.Items.Add(miMore);
        var isAdminNow = chats.TryGetValue(currentChatId, out var cf2) &&
            (Fire.FStr(cf2, "ownerUid") == Fire.Uid || Fire.FList(cf2, "admins").Any(a => a as string == Fire.Uid));
        if (mine || isAdminNow)
        {
            var miDel = new MenuItem { Header = "🗑 Удалить" };
            miDel.Click += async (_, _) =>
            {
                try
                {
                    await Fire.PatchDocAsync($"chats/{currentChatId}/messages/{msgId2}",
                        new() { ["deleted"] = true, ["text"] = "", ["image"] = null, ["reactions"] = new Dictionary<string, object?>() });
                    _ = BumpAsync(currentChatId);
                    loadedMsgs.RemoveAll(x => x.Id == msgId2);
                    RenderMessages();
                }
                catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
            };
            menu.Items.Add(miDel);
        }
        bubble.ContextMenu = menu;
        return bubble;
    }

    async Task VotePollAsync(string messageId, string optionId, bool remove)
    {
        try
        {
            if (remove)
                await Fire.PatchDocAsync($"chats/{currentChatId}/messages/{messageId}", new(), new[] { $"poll.votes.{Fire.Uid}" });
            else
                await Fire.PatchDocAsync($"chats/{currentChatId}/messages/{messageId}",
                    new() { ["poll"] = new Dictionary<string, object?> { ["votes"] = new Dictionary<string, object?> { [Fire.Uid] = optionId } } },
                    new[] { $"poll.votes.{Fire.Uid}" });
            _ = BumpAsync(currentChatId);
            var fresh = await Fire.GetDocAsync($"chats/{currentChatId}/messages/{messageId}");
            if (fresh?["fields"] != null)
            {
                loadedMsgs.RemoveAll(x => x.Id == messageId);
                loadedMsgs.Add((messageId, fresh["fields"]!));
                RenderMessages();
            }
        }
        catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
        catch { }
    }

    void PlayVoice(string? dataUrl)
    {
        if (string.IsNullOrEmpty(dataUrl)) return;
        try
        {
            var b64 = dataUrl[(dataUrl.IndexOf(",") + 1)..];
            var ext = dataUrl.Contains("audio/mp4") ? ".m4a" : ".webm";
            var tmp = Path.Combine(Path.GetTempPath(), $"sandygram_voice_{Guid.NewGuid():N}{ext}");
            File.WriteAllBytes(tmp, Convert.FromBase64String(b64));
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(tmp) { UseShellExecute = true });
        }
        catch (Exception ex) { MessageBox.Show(ex.Message, "SandyGram"); }
    }

    // ================================================================ единая отправка
    async Task SendPayloadAsync(Dictionary<string, object?> extra, string previewText)
    {
        if (string.IsNullOrEmpty(currentChatId) || !chats.TryGetValue(currentChatId, out var f)) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var msgId = Fire.RandomId();
        var members = Fire.FList(f, "members").Select(m => m as string).Where(m => m != null).ToList();
        var msg = new Dictionary<string, object?>
        {
            ["sender"] = Fire.Uid,
            ["senderName"] = myDisplayName.Length > 0 ? myDisplayName : myUsername,
            ["text"] = "",
            ["image"] = null,
            ["createdAt"] = now,
            ["reactions"] = new Dictionary<string, object?>(),
            ["topicId"] = currentTopicId.Length > 0 ? currentTopicId : "general",
        };
        foreach (var kv in extra) msg[kv.Key] = kv.Value;
        if (replyTo != null && extra.ContainsKey("text"))
            msg["replyTo"] = new Dictionary<string, object?> { ["id"] = replyTo.Value.Id, ["sender"] = replyTo.Value.Sender, ["text"] = replyTo.Value.Text };
        var chatUpdateFields = Fire.ToFsFields(new()
        {
            ["lastMessage"] = new Dictionary<string, object?>
            {
                ["text"] = previewText,
                ["senderUid"] = Fire.Uid,
                ["senderName"] = myDisplayName.Length > 0 ? myDisplayName : myUsername,
                ["createdAt"] = now,
                ["hasImage"] = extra.ContainsKey("image") && extra["image"] != null,
            },
            ["lastRead"] = new Dictionary<string, object?> { [Fire.Uid] = now },
            ["unread"] = new Dictionary<string, object?> { [Fire.Uid] = 0L },
        });
        var transforms = members.Where(mb => mb != Fire.Uid).Select(mb => new
        {
            fieldPath = $"unread.{Bq(mb)}",
            increment = new { integerValue = "1" },
        }).ToArray();
        var writes = new List<object>
        {
            new
            {
                update = new { name = Fire.DocName($"chats/{currentChatId}/messages/{msgId}"), fields = Fire.ToFsFields(msg) },
                currentDocument = new { exists = false },
            },
            new
            {
                update = new { name = Fire.DocName($"chats/{currentChatId}"), fields = chatUpdateFields },
                updateMask = new { fieldPaths = new[] { "lastMessage", $"lastRead.{Bq(Fire.Uid)}", $"unread.{Bq(Fire.Uid)}" } },
                updateTransforms = transforms,
            },
        };
        await Fire.CommitAsync(writes.ToArray());
        replyTo = null; replyTargetUid = "";
        ReplyBar.Visibility = Visibility.Collapsed;
        _ = BumpAsync(currentChatId);
        await PollMessagesAsync();
    }

    // ---------- модерация: /mute /warn /ban ----------
    async Task<HashSet<string>> ComputeMentionsAsync(List<string?> members, string text)
    {
        var set = new HashSet<string>();
        var uname = new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var uid in members)
        {
            if (string.IsNullOrEmpty(uid)) continue;
            if (uid == Fire.Uid) continue;
            var u = await GetUserCachedAsync(uid);
            if (u == null) continue;
            var username = Fire.FStr(u, "username");
            if (username.Length > 0) uname[username] = uid;
        }
        var re = new System.Text.RegularExpressions.Regex(@"@([a-z0-9_]{3,24})\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        foreach (System.Text.RegularExpressions.Match mm in re.Matches(text))
        {
            var n = mm.Groups[1].Value.ToLowerInvariant();
            if (uname.TryGetValue(n, out var uid)) set.Add(uid);
        }
        return set;
    }

    long ParseModDuration(string s)
    {
        var t = (s ?? "").Trim().ToLowerInvariant();
        if (t.Length == 0) return -1; // не указано → дефолт
        if (t is "0" or "off" or "нет" or "снять") return 0;
        var rm = System.Text.RegularExpressions.Regex.Match(t, @"^(\d+)\s*([а-яa-z]+)?$");
        if (!rm.Success || !long.TryParse(rm.Groups[1].Value, out var n) || n <= 0) return -2; // не понял
        var u = rm.Groups[2].Value;
        long per = u switch
        {
            "с" or "сек" => 1000,
            "" or "м" or "мин" => 60000,
            "ч" or "час" => 3600000,
            "д" or "день" or "дня" or "дней" => 86400000,
            "мес" => 30L * 86400000,
            _ => 60000,
        };
        return n * per;
    }
    static string FmtModUntil(long ts) => ts >= PermanentUntil ? "навсегда" : DateTimeOffset.FromUnixTimeMilliseconds(ts).ToLocalTime().ToString("dd.MM HH:mm");
    static Dictionary<string, object?> AsObj(Dictionary<string, object?> d) => d;

    async Task HandleSlashAsync(string raw)
    {
        var p = raw.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
        var cmd = p.Length > 0 ? p[0].TrimStart('/').ToLowerInvariant() : "";
        if (cmd is "mute" or "warn" or "ban" or "unmute" or "unban") { await RunModAsync(raw); return; }
        if (cmd == "info")
        {
            var live = currentChatId != null && chats.TryGetValue(currentChatId, out var f0) ? f0 : null;
            if (live == null) return;
            var count = Fire.FList(live, "members").Count;
            MessageBox.Show($"«{Fire.FStr(live, "title")}»\nТип: {Fire.FStr(live, "type")}\nУчастников: {count}", "SandyGram", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (cmd == "theme") { MessageBox.Show("Тема в ПК-версии задаётся автоматически.", "SandyGram", MessageBoxButton.OK, MessageBoxImage.Information); return; }
        if (cmd == "saved")
        {
            var sv = chats.FirstOrDefault(kv => Fire.FStr(kv.Value, "type") == "saved").Key;
            if (sv != null) await OpenChatAsync(sv);
            else MessageBox.Show("Нет «Избранного».", "SandyGram", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (cmd == "help") { MessageBox.Show("/info\n/theme\n/saved\n/help\n(модерация: /mute /warn /ban /unmute /unban)", "SandyGram", MessageBoxButton.OK, MessageBoxImage.Information); return; }
    }

    async Task RunModAsync(string raw)
    {
        var f = chats[currentChatId];
        var type = Fire.FStr(f, "type");
        if (type != "group" && type != "channel") { MessageBox.Show("Команда доступна только в группах/каналах", "SandyGram"); return; }
        bool isAdmin = (Fire.FStr(f, "ownerUid") == Fire.Uid) || Fire.FList(f, "admins").Contains(Fire.Uid);
        if (!isAdmin) { MessageBox.Show("Модерировать — только админ или создатель", "SandyGram"); return; }
        var m = System.Text.RegularExpressions.Regex.Match(raw, @"^/(mute|warn|ban|unmute|unban)(?:\s+(.*))?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success) return;
        var cmd = m.Groups[1].Value.ToLowerInvariant();
        var tokens = (m.Groups[2].Value.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)).ToList();

        var members = Fire.FList(f, "members").Select(x => x as string).Where(x => !string.IsNullOrEmpty(x)).ToList();
        var admins = Fire.FList(f, "admins").Select(x => x as string).Where(x => !string.IsNullOrEmpty(x)).ToList();
        var uname = new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var uid in members)
        {
            if (uid == Fire.Uid) continue;
            var u = await GetUserCachedAsync(uid);
            var username = u == null ? "" : Fire.FStr(u, "username");
            if (username.Length > 0) uname[username] = uid;
        }

        string targetUid = "", targetName = "", timeStr = "";
        if (tokens.Count > 0 && tokens[0].StartsWith("@"))
        {
            if (uname.TryGetValue(tokens[0][1..].ToLowerInvariant(), out var u0)) targetUid = u0;
            targetName = tokens[0];
            if (tokens.Count > 1) timeStr = tokens[1];
        }
        else if (replyTo != null && tokens.Count == 0) { targetUid = replyTargetUid; targetName = replyTo.Value.Sender; }
        else if (replyTo != null && tokens.Count > 0) { targetUid = replyTargetUid; targetName = replyTo.Value.Sender; timeStr = tokens[0]; }
        else if (tokens.Count > 0)
        {
            if (uname.TryGetValue(tokens[0].Replace("@", "").ToLowerInvariant(), out var u1)) targetUid = u1;
            targetName = tokens[0].StartsWith("@") ? tokens[0] : "@" + tokens[0];
            if (tokens.Count > 1) timeStr = tokens[1];
        }
        if (targetUid.Length == 0) { MessageBox.Show("Укажите @имя или ответьте на сообщение", "SandyGram"); return; }
        if (targetUid == Fire.Uid) { MessageBox.Show("Нельзя модерировать себя", "SandyGram"); return; }
        var targetRole = Fire.FStr(f, "ownerUid") == targetUid ? "owner" : (admins.Contains(targetUid) ? "admin" : "member");
        if (targetRole == "owner") { MessageBox.Show("Владельца нельзя модерировать", "SandyGram"); return; }
        if (targetRole == "admin" && Fire.FStr(f, "ownerUid") != Fire.Uid) { MessageBox.Show("Админа может модерировать только создатель", "SandyGram"); return; }
        if (cmd is not ("unban" or "unmute") && !members.Contains(targetUid)) { MessageBox.Show("Пользователя нет в чате", "SandyGram"); return; }

        long dur = timeStr.Length > 0 ? ParseModDuration(timeStr) : (cmd == "warn" ? 1800000L : (cmd == "ban" ? 86400000L : 3600000L));
        if (dur < 0) { MessageBox.Show("Не понял время. Пример: /mute @имя 2ч или 30м", "SandyGram"); return; }

        var mutes = Fire.FMap(f, "mutes");
        var bans = Fire.FMap(f, "bans");
        var warns = Fire.FMap(f, "warns");
        var membersList = members.ToList();
        bool mutesChanged = false, bansChanged = false, warnsChanged = false, membersChanged = false;

        if (cmd == "unmute" || (cmd == "mute" && dur == 0)) { mutes.Remove(targetUid); mutesChanged = true; }
        else if (cmd == "mute") { mutes[targetUid] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + dur; mutesChanged = true; }
        else if (cmd == "warn")
        {
            mutes[targetUid] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + dur; mutesChanged = true;
            warns[targetUid] = (warns.TryGetValue(targetUid, out var wv) ? Convert.ToInt64(wv) : 0) + 1; warnsChanged = true;
        }
        if (cmd == "unban" || (cmd == "ban" && dur == 0))
        {
            if (!membersList.Contains(targetUid)) { membersList.Add(targetUid); membersChanged = true; }
            bans.Remove(targetUid); bansChanged = true;
        }
        else if (cmd == "ban")
        {
            bans[targetUid] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + dur; bansChanged = true;
            membersList.Remove(targetUid); membersChanged = true;
            admins.Remove(targetUid);
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        string noticeText = cmd switch
        {
            "unmute" => $"🔔 {(myDisplayName.Length > 0 ? myDisplayName : myUsername)} снял(а) мут с {targetName}",
            "unban" => $"🚪 {(myDisplayName.Length > 0 ? myDisplayName : myUsername)} снял(а) бан с {targetName}",
            "ban" when dur == 0 => $"🚪 {(myDisplayName.Length > 0 ? myDisplayName : myUsername)} снял(а) бан с {targetName}",
            "mute" when dur == 0 => $"🔔 {(myDisplayName.Length > 0 ? myDisplayName : myUsername)} снял(а) мут с {targetName}",
            "mute" => $"🔕 {(myDisplayName.Length > 0 ? myDisplayName : myUsername)} замутил(а) {targetName} до {FmtModUntil(now + dur)}",
            "warn" => $"⚠️ {(myDisplayName.Length > 0 ? myDisplayName : myUsername)} выдал(а) варн {targetName} и замутил(а) до {FmtModUntil(now + dur)}",
            "ban" => $"🚫 {(myDisplayName.Length > 0 ? myDisplayName : myUsername)} забанил(а) {targetName} до {FmtModUntil(now + dur)}",
            _ => "",
        };

        // заметка в чат (пузырь-уведомление)
        var notice = new Dictionary<string, object?>
        {
            ["sender"] = Fire.Uid, ["senderName"] = myDisplayName.Length > 0 ? myDisplayName : myUsername,
            ["text"] = noticeText, ["notice"] = true, ["createdAt"] = now,
            ["reactions"] = new Dictionary<string, object?>(), ["topicId"] = "general",
        };
        var msgId = Fire.RandomId();

        // патч чата: моды + последнее сообщение + прочтение + непрочитанные
        var chatPatch = new Dictionary<string, object?>
        {
            ["lastMessage"] = new Dictionary<string, object?>
            {
                ["text"] = noticeText, ["senderUid"] = Fire.Uid,
                ["senderName"] = myDisplayName.Length > 0 ? myDisplayName : myUsername,
                ["createdAt"] = now, ["hasImage"] = false,
            },
            ["lastRead"] = new Dictionary<string, object?> { [Fire.Uid] = now },
            ["unread"] = new Dictionary<string, object?> { [Fire.Uid] = 0L },
        };
        var mask = new List<string> { "lastMessage", $"lastRead.{Bq(Fire.Uid)}", $"unread.{Bq(Fire.Uid)}" };
        if (mutesChanged) { chatPatch["mutes"] = AsObj(mutes); mask.Add("mutes"); }
        if (bansChanged) { chatPatch["bans"] = AsObj(bans); mask.Add("bans"); }
        if (warnsChanged) { chatPatch["warns"] = AsObj(warns); mask.Add("warns"); }
        if (membersChanged) { chatPatch["members"] = membersList; mask.Add("members"); }
        if (cmd == "ban") { chatPatch["admins"] = admins; mask.Add("admins"); }

        var transforms = membersList.Where(mb => mb != Fire.Uid).Select(mb => new
        {
            fieldPath = $"unread.{Bq(mb)}",
            increment = new { integerValue = "1" },
        }).ToArray();

        var writes = new object[]
        {
            new
            {
                update = new { name = Fire.DocName($"chats/{currentChatId}/messages/{msgId}"), fields = Fire.ToFsFields(notice) },
                currentDocument = new { exists = false },
            },
            new
            {
                update = new { name = Fire.DocName($"chats/{currentChatId}"), fields = Fire.ToFsFields(chatPatch) },
                updateMask = new { fieldPaths = mask.ToArray() },
                updateTransforms = transforms,
            },
        };
        try
        {
            await Fire.CommitAsync(writes);
            replyTo = null; replyTargetUid = "";
            ReplyBar.Visibility = Visibility.Collapsed;
            _ = BumpAsync(currentChatId);
            await PollMessagesAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message.Contains("PERMISSION") ? "Нет прав на это действие" : ex.Message, "SandyGram");
        }
    }

    void CancelReply_Click(object sender, RoutedEventArgs e)
    {
        replyTo = null; replyTargetUid = "";
        ReplyBar.Visibility = Visibility.Collapsed;
    }

    // фото
    async void AttachBtn_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new Microsoft.Win32.OpenFileDialog { Filter = "Изображения|*.jpg;*.jpeg;*.png;*.webp;*.bmp" };
        if (dlg.ShowDialog() != true) return;
        try
        {
            var dataUrl = EncodeImage(dlg.FileName, 1100, 80);
            if (dataUrl.Length > 700_000) dataUrl = EncodeImage(dlg.FileName, 800, 60);
            if (dataUrl.Length > 900_000) { MessageBox.Show("Фото слишком большое", "SandyGram"); return; }
            await SendPayloadAsync(new() { ["image"] = dataUrl }, "📷 Фото");
        }
        catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
        catch (Exception ex) { MessageBox.Show(ex.Message, "SandyGram"); }
    }

    static string EncodeImage(string path, int maxSide, int quality)
    {
        var src = new BitmapImage();
        src.BeginInit(); src.CacheOption = BitmapCacheOption.OnLoad; src.UriSource = new Uri(path); src.EndInit();
        double scale = Math.Min(1.0, (double)maxSide / Math.Max(src.PixelWidth, src.PixelHeight));
        BitmapSource frame = scale < 1.0 ? new TransformedBitmap(src, new ScaleTransform(scale, scale)) : src;
        var enc = new JpegBitmapEncoder { QualityLevel = quality };
        enc.Frames.Add(BitmapFrame.Create(frame));
        using var ms = new MemoryStream();
        enc.Save(ms);
        return "data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray());
    }

    // стикеры
    void StickerBtn_Click(object sender, RoutedEventArgs e)
    {
        if (StickerGrid.Children.Count == 0)
            foreach (var code in StickerCodes)
            {
                var img = new Image { Width = 62, Height = 62, Margin = new Thickness(5), Cursor = Cursors.Hand };
                var bmp = TryImage($"{Site}/stickers/{code}.png");
                if (bmp != null) img.Source = bmp;
                var c = code;
                img.MouseLeftButtonUp += async (_, _) =>
                {
                    StickerPanel.Visibility = Visibility.Collapsed;
                    try { await SendPayloadAsync(new() { ["sticker"] = c }, "🧩 Стикер"); }
                    catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
                };
                StickerGrid.Children.Add(img);
            }
        StickerPanel.Visibility = Visibility.Visible;
    }
    void CloseStickers_Click(object sender, RoutedEventArgs e) => StickerPanel.Visibility = Visibility.Collapsed;

    // голосовые (NAudio: WAV → AAC m4a)
    async void MicBtn_Click(object sender, RoutedEventArgs e)
    {
        if (recorder != null)
        {
            try
            {
                recorder.StopRecording();
                recorder.Dispose(); recorder = null;
                recWriter?.Dispose(); recWriter = null;
                MicBtn.Content = "🎙";
                var dur = Math.Max(1, (int)Math.Round((DateTime.UtcNow - recStart).TotalSeconds));
                var m4a = Path.ChangeExtension(recPath, ".m4a");
                using (var reader = new NAudio.Wave.AudioFileReader(recPath))
                    NAudio.Wave.MediaFoundationEncoder.EncodeToAac(reader, m4a, 32000);
                var bytes = File.ReadAllBytes(m4a);
                File.Delete(recPath); File.Delete(m4a);
                var dataUrl = "data:audio/mp4;base64," + Convert.ToBase64String(bytes);
                if (dataUrl.Length > 900_000) { MessageBox.Show("Слишком длинное голосовое (макс ~1 минута)", "SandyGram"); return; }
                await SendPayloadAsync(new() { ["voice"] = new Dictionary<string, object?> { ["data"] = dataUrl, ["duration"] = (long)dur } }, "🎤 Голосовое сообщение");
            }
            catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
            catch (Exception ex) { MessageBox.Show("Не удалось записать: " + ex.Message, "SandyGram"); }
            return;
        }
        try
        {
            recPath = Path.Combine(Path.GetTempPath(), $"sg_rec_{Guid.NewGuid():N}.wav");
            recorder = new NAudio.Wave.WaveInEvent { WaveFormat = new NAudio.Wave.WaveFormat(22050, 16, 1) };
            recWriter = new NAudio.Wave.WaveFileWriter(recPath, recorder.WaveFormat);
            recorder.DataAvailable += (_, a) => recWriter?.Write(a.Buffer, 0, a.BytesRecorded);
            recorder.StartRecording();
            recStart = DateTime.UtcNow;
            MicBtn.Content = "⏹";
        }
        catch (Exception ex) { MessageBox.Show("Нет доступа к микрофону: " + ex.Message, "SandyGram"); recorder = null; }
    }

    // реакции
    async Task ToggleReactionAsync(string messageId, string emoji)
    {
        var msg = loadedMsgs.FirstOrDefault(x => x.Id == messageId);
        if (msg.Fields == null) return;
        var reactions = Fire.FMap(msg.Fields, "reactions");
        var mine = reactions.TryGetValue(emoji, out var lst) && lst is List<object?> l && l.Any(x => x as string == Fire.Uid);
        var fieldPath = "reactions." + Bq(emoji);
        object transform = mine
            ? new { fieldPath, removeAllFromArray = new { values = new[] { new { stringValue = Fire.Uid } } } }
            : new { fieldPath, appendMissingElements = new { values = new[] { new { stringValue = Fire.Uid } } } };
        var writes = new object[]
        {
            new { transform = new { document = Fire.DocName($"chats/{currentChatId}/messages/{messageId}"), fieldTransforms = new[] { transform } } },
        };
        try
        {
            await Fire.CommitAsync(writes);
            _ = BumpAsync(currentChatId);
            var fresh = await Fire.GetDocAsync($"chats/{currentChatId}/messages/{messageId}");
            if (fresh?["fields"] != null)
            {
                loadedMsgs.RemoveAll(x => x.Id == messageId);
                loadedMsgs.Add((messageId, fresh["fields"]!));
                RenderMessages();
            }
        }
        catch (FireException ex) { MessageBox.Show(ex.Ru, "SandyGram"); }
    }

    // ================================================================ отправка
    void MsgInput_KeyDown(object sender, KeyEventArgs e)
    {
        if (MentionBox.Visibility == Visibility.Visible)
        {
            if (e.Key == Key.Up) { e.Handled = true; MoveMention(-1); return; }
            if (e.Key == Key.Down) { e.Handled = true; MoveMention(1); return; }
            if (e.Key == Key.Enter || e.Key == Key.Tab) { e.Handled = true; InsertMentionSelected(); return; }
            if (e.Key == Key.Escape) { e.Handled = true; MentionBox.Visibility = Visibility.Collapsed; return; }
        }
        // Горячие клавиши форматирования выделенного, как в Telegram
        if ((Keyboard.Modifiers & ModifierKeys.Control) != 0 && MsgInput.SelectionLength > 0)
        {
            var shift = (Keyboard.Modifiers & ModifierKeys.Shift) != 0;
            string? mark = e.Key switch
            {
                Key.B when !shift => "**",
                Key.I when !shift => "*",
                Key.X when shift => "~~",
                Key.M when shift => "`",
                Key.P when shift => "||",
                Key.N when shift => "",
                _ => null,
            };
            if (mark != null) { e.Handled = true; ApplyInputFormat(mark); return; }
        }
        if (e.Key == Key.Enter) { e.Handled = true; SendBtn_Click(sender, e); }
    }

    // 3.0: обернуть выделенный кусок в разметку (пустой mark — снять форматирование)
    void ApplyInputFormat(string mark)
    {
        var start = MsgInput.SelectionStart;
        var len = MsgInput.SelectionLength;
        if (len <= 0) return;
        var picked = MsgInput.Text.Substring(start, len);
        var inner = System.Text.RegularExpressions.Regex.Replace(picked, @"```([\s\S]*?)```", "$1");
        inner = System.Text.RegularExpressions.Regex.Replace(inner, @"\|\|([\s\S]+?)\|\|", "$1");
        inner = System.Text.RegularExpressions.Regex.Replace(inner, @"\*\*([^*\n]+)\*\*", "$1");
        inner = System.Text.RegularExpressions.Regex.Replace(inner, @"~~([^~\n]+)~~", "$1");
        inner = System.Text.RegularExpressions.Regex.Replace(inner, @"\*([^*\n]+)\*", "$1");
        inner = System.Text.RegularExpressions.Regex.Replace(inner, @"`([^`\n]+)`", "$1");
        // тот же значок второй раз — снимаем
        var already = mark.Length > 0 && picked.StartsWith(mark) && picked.EndsWith(mark) && picked.Length > mark.Length * 2;
        var outText = mark.Length == 0 || already ? inner : mark + inner + mark;
        MsgInput.Text = MsgInput.Text.Remove(start, len).Insert(start, outText);
        MsgInput.Select(start, outText.Length);
        MsgInput.Focus();
    }

    // ПКМ по выделенному тексту в поле ввода — меню начертаний
    void BuildFormatMenu()
    {
        var menu = new ContextMenu();
        // штатные пункты остаются — своё меню заменяет системное целиком
        menu.Items.Add(new MenuItem { Header = "Вырезать", Command = ApplicationCommands.Cut });
        menu.Items.Add(new MenuItem { Header = "Копировать", Command = ApplicationCommands.Copy });
        menu.Items.Add(new MenuItem { Header = "Вставить", Command = ApplicationCommands.Paste });
        menu.Items.Add(new Separator());
        var fmtItems = new List<MenuItem>();
        foreach (var (header, mark) in new[]
        {
            ("Жирный  (Ctrl+B)", "**"), ("Курсив  (Ctrl+I)", "*"),
            ("Зачёркнутый  (Ctrl+Shift+X)", "~~"), ("Моноширинный  (Ctrl+Shift+M)", "`"),
            ("Спойлер  (Ctrl+Shift+P)", "||"), ("Убрать форматирование  (Ctrl+Shift+N)", ""),
        })
        {
            var mi = new MenuItem { Header = header };
            var mk = mark;
            mi.Click += (_, _) => ApplyInputFormat(mk);
            fmtItems.Add(mi);
            menu.Items.Add(mi);
        }
        // без выделения форматировать нечего — гасим пункты
        menu.Opened += (_, _) => { foreach (var mi in fmtItems) mi.IsEnabled = MsgInput.SelectionLength > 0; };
        MsgInput.ContextMenu = menu;
    }

    // ---------- @-пикер упоминаний (десктоп) ----------
    readonly List<(string Username, string DisplayName, string Uid)> mentionPool = new();
    async Task LoadMentionPoolAsync()
    {
        mentionPool.Clear();
        if (!chats.TryGetValue(currentChatId, out var f)) return;
        foreach (var uid in Fire.FList(f, "members").Select(x => x as string).Where(x => !string.IsNullOrEmpty(x)))
        {
            if (uid == Fire.Uid) continue;
            var u = await GetUserCachedAsync(uid);
            if (u == null) continue;
            var uname = Fire.FStr(u, "username"); var dname = Fire.FStr(u, "displayName");
            if (uname.Length > 0) mentionPool.Add((uname, dname, uid));
        }
    }
    void MsgInput_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (string.IsNullOrEmpty(currentChatId)) return;
        var val = MsgInput.Text;
        var sel = Math.Min(MsgInput.CaretIndex, val.Length);
        var m = System.Text.RegularExpressions.Regex.Match(val[..sel], @"(?:^|[\s(])@([a-z0-9_]*)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (!m.Success || m.Groups[1].Value.Length == 0) { MentionBox.Visibility = Visibility.Collapsed; return; }
        var q = m.Groups[1].Value.ToLowerInvariant();
        var hits = mentionPool.Where(p => p.Username.ToLowerInvariant().StartsWith(q)).Take(8).ToList();
        if (hits.Count == 0) { MentionBox.Visibility = Visibility.Collapsed; return; }
        MentionList.Items.Clear();
        foreach (var h in hits)
            MentionList.Items.Add(h.Username + (h.DisplayName.Length > 0 && h.DisplayName != h.Username ? $"  ·  {h.DisplayName}" : ""));
        MentionList.SelectedIndex = 0;
        MentionBox.Visibility = Visibility.Visible;
    }
    void MoveMention(int dir)
    {
        var n = MentionList.Items.Count;
        if (n == 0) return;
        MentionList.SelectedIndex = (MentionList.SelectedIndex + dir + n) % n;
    }
    void InsertMentionSelected()
    {
        if (MentionList.SelectedItem is not string chosen) { MentionBox.Visibility = Visibility.Collapsed; return; }
        var uname = chosen.Split("  ·  ")[0];
        var val = MsgInput.Text;
        var sel = Math.Min(MsgInput.CaretIndex, val.Length);
        var m = System.Text.RegularExpressions.Regex.Match(val[..sel], @"(?:^|[\s(])@([a-z0-9_]*)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        string nv; int caret;
        if (m.Success)
        {
            var start = m.Groups[0].Index + m.Groups[0].Value.LastIndexOf('@');
            nv = val[..start] + "@" + uname + " " + val[sel..];
            caret = start + uname.Length + 2;
        }
        else { nv = MsgInput.Text.TrimEnd() + " @" + uname + " "; caret = nv.Length; }
        MsgInput.Text = nv;
        MsgInput.CaretIndex = Math.Min(caret, nv.Length);
        MentionBox.Visibility = Visibility.Collapsed;
        MsgInput.Focus();
    }

    async void SendBtn_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(currentChatId)) return;
        var text = MsgInput.Text.Trim();
        if (text.Length == 0) return;
        if (!chats.TryGetValue(currentChatId, out var f)) return;
        if (ModCmdRe.IsMatch(text)) { MsgInput.Text = ""; drafts.Remove(currentChatId); await HandleSlashAsync(text); MsgInput.Focus(); return; }
        if (sending) return;
        sending = true;
        MsgInput.Text = ""; // мгновенно, защита от спама
        drafts.Remove(currentChatId);
        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var msgId = Fire.RandomId();
            var members = Fire.FList(f, "members").Select(m => m as string).Where(m => m != null).ToList();
            var msg = new Dictionary<string, object?>
            {
                ["sender"] = Fire.Uid,
                ["senderName"] = myDisplayName.Length > 0 ? myDisplayName : myUsername,
                ["text"] = text.Length > 4000 ? text[..4000] : text,
                ["image"] = null,
                ["createdAt"] = now,
                ["reactions"] = new Dictionary<string, object?>(),
                ["topicId"] = "general",
            };
            // @упоминания → массив uid
            var mentionUid = await ComputeMentionsAsync(members, text);
            if (mentionUid.Count > 0) msg["mentions"] = mentionUid.ToList();
            var msgFields = Fire.ToFsFields(msg);
            var chatUpdateFields = Fire.ToFsFields(new()
            {
                ["lastMessage"] = new Dictionary<string, object?>
                {
                    ["text"] = text.Length > 4000 ? text[..4000] : text,
                    ["senderUid"] = Fire.Uid,
                    ["senderName"] = myDisplayName.Length > 0 ? myDisplayName : myUsername,
                    ["createdAt"] = now,
                    ["hasImage"] = false,
                },
                ["lastRead"] = new Dictionary<string, object?> { [Fire.Uid] = now },
                ["unread"] = new Dictionary<string, object?> { [Fire.Uid] = 0L },
            });
            var transforms = members.Where(mb => mb != Fire.Uid).Select(mb => new
            {
                fieldPath = $"unread.{Bq(mb)}",
                increment = new { integerValue = "1" },
            }).ToArray();

            var writes = new List<object>
            {
                new
                {
                    update = new { name = Fire.DocName($"chats/{currentChatId}/messages/{msgId}"), fields = msgFields },
                    currentDocument = new { exists = false },
                },
                new
                {
                    update = new { name = Fire.DocName($"chats/{currentChatId}"), fields = chatUpdateFields },
                    updateMask = new { fieldPaths = new[] { "lastMessage", $"lastRead.{Bq(Fire.Uid)}", $"unread.{Bq(Fire.Uid)}" } },
                    updateTransforms = transforms,
                },
            };
            await Fire.CommitAsync(writes.ToArray());
            _ = BumpAsync(currentChatId);
            await PollMessagesAsync();
        }
        catch (FireException ex)
        {
            MsgInput.Text = text;
            var isPrivate = Fire.FStr(f, "type") == "private";
            MessageBox.Show(isPrivate && ex.Message.Contains("PERMISSION") ? "🚫 Этот пользователь ограничил круг тех, кто может ему писать" : ex.Ru, "SandyGram");
        }
        catch (Exception ex) { MsgInput.Text = text; MessageBox.Show(ex.Message, "SandyGram"); }
        finally { sending = false; MsgInput.Focus(); }
    }
}
