// SandyGram Desktop — клиент Firebase (Auth + Firestore) через REST
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace SandyGram;

public static class Fire
{
    public const string ApiKey = "AIzaSyAjGwFBdfll--_ohWWlaZmV3JT2ksRD7vk";
    public const string Project = "sandygram-a3b42";
    static readonly string FsBase = $"https://firestore.googleapis.com/v1/projects/{Project}/databases/(default)/documents";
    static readonly HttpClient http = new();

    public static string IdToken = "";
    public static string RefreshToken = "";
    public static string Uid = "";
    static DateTime tokenExpires = DateTime.MinValue;

    // ---------- Auth ----------
    public static async Task<JsonNode> AuthAsync(string endpoint, object body)
    {
        var r = await http.PostAsJsonAsync($"https://identitytoolkit.googleapis.com/v1/accounts:{endpoint}?key={ApiKey}", body);
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        if (j["error"] != null) throw new FireException(j["error"]!["message"]?.GetValue<string>() ?? "AUTH_ERROR");
        return j;
    }

    public static async Task SignInAsync(string email, string password)
    {
        var j = await AuthAsync("signInWithPassword", new { email, password, returnSecureToken = true });
        ApplyAuth(j);
    }

    public static async Task SignUpAsync(string email, string password)
    {
        var j = await AuthAsync("signUp", new { email, password, returnSecureToken = true });
        ApplyAuth(j);
    }

    static void ApplyAuth(JsonNode j)
    {
        IdToken = j["idToken"]!.GetValue<string>();
        RefreshToken = j["refreshToken"]!.GetValue<string>();
        Uid = j["localId"]!.GetValue<string>();
        tokenExpires = DateTime.UtcNow.AddSeconds(double.Parse(j["expiresIn"]!.GetValue<string>()) - 120);
    }

    // вход по refresh-токену (из QR-обмена с телефоном)
    public static async Task SignInWithRefreshTokenAsync(string refresh)
    {
        var r = await http.PostAsync($"https://securetoken.googleapis.com/v1/token?key={ApiKey}",
            new FormUrlEncodedContent(new Dictionary<string, string> { ["grant_type"] = "refresh_token", ["refresh_token"] = refresh }));
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        if (j["error"] != null) throw new FireException(j["error"]!["message"]?.GetValue<string>() ?? "QR_AUTH_FAILED");
        IdToken = j["id_token"]!.GetValue<string>();
        RefreshToken = j["refresh_token"]!.GetValue<string>();
        Uid = j["user_id"]!.GetValue<string>();
        tokenExpires = DateTime.UtcNow.AddSeconds(double.Parse(j["expires_in"]!.GetValue<string>()) - 120);
    }

    // RTDB: чтение и запись qrlogin-узла (правила позволяют неавторизованно)
    public static async Task<JsonNode?> GetRtdbJsonAsync(string path)
    {
        var r = await http.GetAsync($"https://sandygram-a3b42-default-rtdb.europe-west1.firebasedatabase.app/{path}.json");
        if (!r.IsSuccessStatusCode) return null;
        var text = await r.Content.ReadAsStringAsync();
        return text.Trim() == "null" ? null : JsonNode.Parse(text);
    }

    public static async Task PutRtdbJsonAsync(string path, object body)
    {
        await http.PutAsync($"https://sandygram-a3b42-default-rtdb.europe-west1.firebasedatabase.app/{path}.json", JsonContent.Create(body));
    }

    public static async Task DeleteRtdbAsync(string path)
    {
        await http.PutAsync($"https://sandygram-a3b42-default-rtdb.europe-west1.firebasedatabase.app/{path}.json", new StringContent("null", System.Text.Encoding.UTF8, "application/json"));
    }

    public static async Task EnsureTokenAsync()
    {
        if (string.IsNullOrEmpty(RefreshToken) || DateTime.UtcNow < tokenExpires) return;
        var r = await http.PostAsync($"https://securetoken.googleapis.com/v1/token?key={ApiKey}",
            new FormUrlEncodedContent(new Dictionary<string, string> { ["grant_type"] = "refresh_token", ["refresh_token"] = RefreshToken }));
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        if (j["error"] != null) throw new FireException("SESSION_EXPIRED");
        IdToken = j["id_token"]!.GetValue<string>();
        RefreshToken = j["refresh_token"]!.GetValue<string>();
        Uid = j["user_id"]!.GetValue<string>();
        tokenExpires = DateTime.UtcNow.AddSeconds(double.Parse(j["expires_in"]!.GetValue<string>()) - 120);
    }

    static async Task<HttpRequestMessage> Req(HttpMethod m, string url, object? body = null)
    {
        await EnsureTokenAsync();
        var req = new HttpRequestMessage(m, url);
        req.Headers.Add("Authorization", $"Bearer {IdToken}");
        if (body != null) req.Content = JsonContent.Create(body);
        return req;
    }

    // Чтение usernames/{name} без авторизации (правила разрешают публичный get)
    public static async Task<JsonNode?> AuthNoThrowGetUsernameDoc(string name)
    {
        var r = await http.GetAsync($"{FsBase}/usernames/{name}");
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        return j["error"] != null ? null : j;
    }

    // ---------- Firestore ----------
    // null — только если документа нет; другие ошибки (нет прав, сеть) пробрасываются
    public static async Task<JsonNode?> GetDocAsync(string path)
    {
        var r = await http.SendAsync(await Req(HttpMethod.Get, $"{FsBase}/{path}"));
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        if (j["error"] == null) return j;
        var status = j["error"]!["status"]?.GetValue<string>() ?? "";
        if (status == "NOT_FOUND") return null;
        throw new FireException(j["error"]!["message"]?.GetValue<string>() ?? status);
    }

    public static async Task PatchDocAsync(string path, Dictionary<string, object?> fields, IEnumerable<string>? mask = null)
    {
        var maskQ = string.Join("&", (mask ?? fields.Keys).Select(f => $"updateMask.fieldPaths={Uri.EscapeDataString(f)}"));
        var r = await http.SendAsync(await Req(HttpMethod.Patch, $"{FsBase}/{path}?{maskQ}", new { fields = ToFsFields(fields) }));
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        if (j["error"] != null) throw new FireException(j["error"]!["message"]?.GetValue<string>() ?? "WRITE_ERROR");
    }

    public static async Task SetDocAsync(string path, Dictionary<string, object?> fields)
    {
        var i = path.LastIndexOf('/');
        var parent = path[..i]; var id = path[(i + 1)..];
        var url = parent.Contains('/')
            ? $"{FsBase}/{parent[..parent.LastIndexOf('/')]}/{parent[(parent.LastIndexOf('/') + 1)..]}?documentId={id}"
            : $"{FsBase}/{parent}?documentId={id}";
        var r = await http.SendAsync(await Req(HttpMethod.Post, url, new { fields = ToFsFields(fields) }));
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        if (j["error"] != null)
        {
            var msg = j["error"]!["message"]?.GetValue<string>() ?? "WRITE_ERROR";
            if (msg.Contains("already exists")) return; // документ уже есть — это ок для ensure-логики
            throw new FireException(msg);
        }
    }

    public static async Task<List<(string Id, JsonNode Fields)>> RunQueryAsync(object structuredQuery)
    {
        var r = await http.SendAsync(await Req(HttpMethod.Post, $"{FsBase}:runQuery", new { structuredQuery }));
        var text = await r.Content.ReadAsStringAsync();
        var arr = JsonNode.Parse(text) as JsonArray ?? new JsonArray();
        var list = new List<(string, JsonNode)>();
        foreach (var row in arr)
        {
            var docNode = row?["document"];
            if (docNode == null) continue;
            var name = docNode["name"]!.GetValue<string>();
            list.Add((name[(name.LastIndexOf('/') + 1)..], docNode["fields"] ?? new JsonObject()));
        }
        return list;
    }

    public static async Task CommitAsync(object[] writes)
    {
        var r = await http.SendAsync(await Req(HttpMethod.Post, $"{FsBase}:commit", new { writes }));
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync())!;
        if (j["error"] != null) throw new FireException(j["error"]!["message"]?.GetValue<string>() ?? "WRITE_ERROR");
    }

    public static string DocName(string path) => $"projects/{Project}/databases/(default)/documents/{path}";

    // ---------- конвертация значений ----------
    public static Dictionary<string, object> ToFsFields(Dictionary<string, object?> fields)
        => fields.ToDictionary(kv => kv.Key, kv => ToFsValue(kv.Value));

    public static object ToFsValue(object? v) => v switch
    {
        null => new { nullValue = (object?)null },
        bool b => new { booleanValue = b },
        int i => new { integerValue = i.ToString() },
        long l => new { integerValue = l.ToString() },
        double d => new { doubleValue = d },
        string s => new { stringValue = s },
        IEnumerable<object?> arr => new { arrayValue = new { values = arr.Select(ToFsValue).ToArray() } },
        Dictionary<string, object?> map => new { mapValue = new { fields = ToFsFields(map) } },
        _ => new { stringValue = v.ToString() ?? "" },
    };

    public static object? FromFs(JsonNode? v)
    {
        if (v == null) return null;
        var o = v.AsObject();
        if (o.ContainsKey("stringValue")) return o["stringValue"]!.GetValue<string>();
        if (o.ContainsKey("integerValue")) return long.Parse(o["integerValue"]!.GetValue<string>());
        if (o.ContainsKey("doubleValue")) return o["doubleValue"]!.GetValue<double>();
        if (o.ContainsKey("booleanValue")) return o["booleanValue"]!.GetValue<bool>();
        if (o.ContainsKey("nullValue")) return null;
        if (o.ContainsKey("arrayValue")) return (o["arrayValue"]!["values"] as JsonArray ?? new JsonArray()).Select(FromFs).ToList();
        if (o.ContainsKey("mapValue")) return (o["mapValue"]!["fields"] as JsonObject ?? new JsonObject())
            .ToDictionary(kv => kv.Key, kv => FromFs(kv.Value));
        return null;
    }

    // удобный доступ к полям документа
    public static object? F(JsonNode fields, string key) => FromFs(fields[key]);
    public static string FStr(JsonNode fields, string key) => F(fields, key) as string ?? "";
    public static long FLong(JsonNode fields, string key) => F(fields, key) is long l ? l : 0;
    public static List<object?> FList(JsonNode fields, string key) => F(fields, key) as List<object?> ?? new();
    public static Dictionary<string, object?> FMap(JsonNode fields, string key) => F(fields, key) as Dictionary<string, object?> ?? new();

    public static string RandomId(int len = 20)
    {
        const string chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        var rnd = Random.Shared;
        return new string(Enumerable.Range(0, len).Select(_ => chars[rnd.Next(chars.Length)]).ToArray());
    }
}

public class FireException : Exception
{
    public FireException(string code) : base(code) { }
    public string Ru => Message switch
    {
        var m when m.Contains("EMAIL_EXISTS") => "Такой пользователь уже существует.",
        var m when m.Contains("INVALID_LOGIN_CREDENTIALS") || m.Contains("INVALID_PASSWORD") || m.Contains("EMAIL_NOT_FOUND") => "Неверное имя пользователя или пароль.",
        var m when m.Contains("TOO_MANY_ATTEMPTS") => "Слишком много попыток. Подождите минуту.",
        var m when m.Contains("QUOTA_EXCEEDED") || m.Contains("Quota exceeded") => "Слишком много попыток входа — подождите пару минут и попробуйте снова.",
        var m when m.Contains("PERMISSION_DENIED") || m.Contains("Missing or insufficient") => "Нет прав на это действие.",
        var m when m.Contains("SESSION_EXPIRED") => "Сессия истекла — войдите заново.",
        var m => m,
    };
}
