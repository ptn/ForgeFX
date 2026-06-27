using System.Text.Json;
using System.Text.RegularExpressions;

// ForgeFX.NameSync — turn saved Fractal wiki "*_models" pages (MediaWiki source)
// into ForgeFX name maps (definitions/names/<slug>.json): Fractal model name →
// real-world manufacturer + the amp/pedal it is based on.
//
// The wiki is Cloudflare-gated, so this tool does NOT fetch it. A maintainer
// opens each models page in a browser (Edit source / ?action=raw), saves the
// wikitext, and points this tool at the folder:
//
//   dotnet run --project tools/ForgeFX.NameSync -- <input-dir> <output-dir>
//   (defaults: <input-dir>=. , <output-dir>=definitions/names)
//
// Source: Fractal Audio Wiki (https://wiki.fractalaudio.com). Names are factual
// references; see NOTICE for attribution.

var inputDir = args.Length > 0 ? args[0] : ".";
var outputDir = args.Length > 1 ? args[1] : Path.Combine("definitions", "names");
Directory.CreateDirectory(outputDir);

// saved file (basename) -> (catalog slug, parse mode)
var sources = new (string File, string Slug, string Mode, string WikiPage)[]
{
    ("amp_models",    "amp",    "table",    "Amp models"),
    ("drive_models",  "drive",  "sections", "Drive models"),
    ("chorus_models", "chorus", "sections", "Chorus models"),
};

var json = new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
int totalFiles = 0;

foreach (var src in sources)
{
    var path = Path.Combine(inputDir, src.File);
    if (!File.Exists(path)) { Console.WriteLine($"skip {src.File} (not found)"); continue; }
    var text = File.ReadAllText(path);

    var models = src.Mode == "table" ? ParseAmpTable(text) : ParseSections(text);
    if (models.Count == 0) { Console.WriteLine($"warn {src.File}: 0 models parsed"); continue; }

    var doc = new ModelDoc(src.Slug, $"Fractal Audio Wiki — {src.WikiPage}", models.Count, models);
    var outPath = Path.Combine(outputDir, $"{src.Slug}.json");
    File.WriteAllText(outPath, JsonSerializer.Serialize(doc, json));
    Console.WriteLine($"{src.Slug,-7} {models.Count,3} models -> {outPath}");
    totalFiles++;
}

Console.WriteLine($"done: {totalFiles} name map(s)");
return totalFiles > 0 ? 0 : 1;

// ---- parsers ----

// Summary table: rows of  |  <slot> || <Manufacturer> || [[#anchor | NAME (basedOn)]]
static List<ModelName> ParseAmpTable(string text)
{
    var outv = new List<ModelName>();
    var lines = text.Replace("\r", "").Split('\n');
    bool inTable = false;
    foreach (var raw in lines)
    {
        var line = raw.TrimEnd();
        if (!inTable)
        {
            if (line.StartsWith("{|") && line.Contains("sortable")) inTable = true;
            continue;
        }
        if (line.StartsWith("|}")) break;
        if (!line.StartsWith("|") || line.StartsWith("|-") || !line.Contains("||")) continue;

        var cells = line[1..].Split("||");
        if (cells.Length < 3) continue;
        if (!int.TryParse(cells[0].Trim(), out var slot)) continue;
        var manufacturer = CleanWs(cells[1]);
        var display = LinkDisplay(string.Join("||", cells[2..]));
        var (name, basedOn) = SplitNameDesc(display);
        if (name.Length == 0) continue;
        outv.Add(new ModelName(slot, name, manufacturer.Length > 0 ? manufacturer : null, basedOn));
    }
    return outv;
}

// Level-2 section headings: ==NAME (basedOn)==  (one per model)
static List<ModelName> ParseSections(string text)
{
    var outv = new List<ModelName>();
    var lines = text.Replace("\r", "").Split('\n');
    int idx = 0;
    foreach (var raw in lines)
    {
        var line = raw.Trim();
        if (line.Length < 5 || !line.StartsWith("==") || line.StartsWith("===")) continue;
        if (!line.EndsWith("==") || line.EndsWith("===")) continue;
        var heading = line.Trim('=').Trim();
        if (heading.Length == 0) continue;
        var (name, basedOn) = SplitNameDesc(heading);
        if (name.Length == 0) continue;
        outv.Add(new ModelName(++idx, name, null, basedOn));
    }
    return outv;
}

// "[[#anchor | display]]" -> "display"; passthrough if not a link.
static string LinkDisplay(string cell)
{
    var m = Regex.Match(cell, @"\[\[[^\]]*?\|\s*(?<d>[^\]]+?)\s*\]\]");
    if (m.Success) return m.Groups["d"].Value.Trim();
    return Regex.Replace(cell, @"\[\[|\]\]", "").Trim();
}

// "NAME (based on …)" -> ("NAME", "based on …"); no parens -> (heading, null).
static (string name, string? basedOn) SplitNameDesc(string s)
{
    s = s.Trim();
    var m = Regex.Match(s, @"^(?<n>[^(]+?)\s*\((?<d>.*)\)\s*$");
    if (m.Success) return (m.Groups["n"].Value.Trim(), m.Groups["d"].Value.Trim());
    return (s, null);
}

static string CleanWs(string s) => Regex.Replace(s.Replace("\t", " "), @"\s+", " ").Trim();

record ModelName(int Value, string Name, string? Manufacturer, string? BasedOn);
record ModelDoc(string Block, string Source, int Count, List<ModelName> Models);
