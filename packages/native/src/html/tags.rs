//! The user agent style of each HTML tag, from Chrome's `html.css`: one JSON style a tag, parsed
//! with the path every `setStyle` goes through.
//!
//! What a per-tag layer cannot say stays out: a rule that needs the element's place (`ul ul`) or
//! its attributes (`a:any-link`, `details[open]`), the markers of `li`, the quotes of `q`, and the
//! generic family `monospace` with its 13px size (`pre`, `kbd` and `samp` take `Menlo` at the
//! size they inherit).

pub(super) const TAGS: &[(&str, &str)] = &[
    ("p", r#"{"display":"block","marginTop":"1em","marginBottom":"1em"}"#),
    ("h1", r#"{"display":"block","fontSize":"2em","fontWeight":700,"marginTop":"0.67em","marginBottom":"0.67em"}"#),
    ("h2", r#"{"display":"block","fontSize":"1.5em","fontWeight":700,"marginTop":"0.83em","marginBottom":"0.83em"}"#),
    ("h3", r#"{"display":"block","fontSize":"1.17em","fontWeight":700,"marginTop":"1em","marginBottom":"1em"}"#),
    ("h4", r#"{"display":"block","fontWeight":700,"marginTop":"1.33em","marginBottom":"1.33em"}"#),
    ("h5", r#"{"display":"block","fontSize":"0.83em","fontWeight":700,"marginTop":"1.67em","marginBottom":"1.67em"}"#),
    ("h6", r#"{"display":"block","fontSize":"0.67em","fontWeight":700,"marginTop":"2.33em","marginBottom":"2.33em"}"#),
    ("ul", r#"{"display":"block","marginTop":"1em","marginBottom":"1em","paddingInline":"40px 0"}"#),
    ("ol", r#"{"display":"block","marginTop":"1em","marginBottom":"1em","paddingInline":"40px 0"}"#),
    ("li", r#"{"display":"block"}"#),
    ("dl", r#"{"display":"block","marginTop":"1em","marginBottom":"1em"}"#),
    ("dt", r#"{"display":"block"}"#),
    ("dd", r#"{"display":"block","marginInline":"40px 0"}"#),
    ("section", r#"{"display":"block"}"#),
    ("nav", r#"{"display":"block"}"#),
    ("header", r#"{"display":"block"}"#),
    ("footer", r#"{"display":"block"}"#),
    ("main", r#"{"display":"block"}"#),
    ("article", r#"{"display":"block"}"#),
    ("aside", r#"{"display":"block"}"#),
    ("figure", r#"{"display":"block","marginTop":"1em","marginBottom":"1em","marginInline":"40px"}"#),
    ("figcaption", r#"{"display":"block"}"#),
    ("blockquote", r#"{"display":"block","marginTop":"1em","marginBottom":"1em","marginInline":"40px"}"#),
    ("pre", r#"{"display":"block","whiteSpace":"pre","fontFamily":"Menlo","marginTop":"1em","marginBottom":"1em"}"#),
    (
        "fieldset",
        r##"{"display":"block","marginInline":"2px","paddingBlock":"0.35em 0.625em","paddingInline":"0.75em","borderWidth":2,"borderStyle":"groove","borderColor":"#efefef"}"##,
    ),
    ("legend", r#"{"display":"block","paddingInline":"2px"}"#),
    ("address", r#"{"display":"block","fontStyle":"italic"}"#),
    (
        "hr",
        r##"{"display":"block","overflow":"hidden","color":"#808080","marginTop":"0.5em","marginBottom":"0.5em","marginInline":"auto","borderWidth":1,"borderStyle":"inset","borderColor":"currentColor"}"##,
    ),
    ("details", r#"{"display":"block"}"#),
    ("summary", r#"{"display":"block"}"#),
    // Closed, which is all a tag can say: `open` is an attribute.
    ("dialog", r#"{"display":"none"}"#),
    ("a", r#"{"display":"inline"}"#),
    ("strong", r#"{"display":"inline","fontWeight":700}"#),
    ("em", r#"{"display":"inline","fontStyle":"italic"}"#),
    ("b", r#"{"display":"inline","fontWeight":700}"#),
    ("i", r#"{"display":"inline","fontStyle":"italic"}"#),
    ("u", r#"{"display":"inline","textDecorationLine":"underline"}"#),
    ("s", r#"{"display":"inline","textDecorationLine":"line-through"}"#),
    ("small", r#"{"display":"inline","fontSize":"0.8333333em"}"#),
    ("mark", r##"{"display":"inline","backgroundColor":"#ffff00","color":"#000000"}"##),
    ("abbr", r#"{"display":"inline"}"#),
    ("cite", r#"{"display":"inline","fontStyle":"italic"}"#),
    ("q", r#"{"display":"inline"}"#),
    ("sub", r#"{"display":"inline","fontSize":"0.8333333em","verticalAlign":"sub"}"#),
    ("sup", r#"{"display":"inline","fontSize":"0.8333333em","verticalAlign":"super"}"#),
    ("time", r#"{"display":"inline"}"#),
    ("kbd", r#"{"display":"inline","fontFamily":"Menlo"}"#),
    ("var", r#"{"display":"inline","fontStyle":"italic"}"#),
    ("samp", r#"{"display":"inline","fontFamily":"Menlo"}"#),
    ("br", r#"{"display":"inline"}"#),
    ("wbr", r#"{"display":"inline"}"#),
    (
        "button",
        r##"{"display":"inline-block","boxSizing":"border-box","padding":"1px 6px","borderWidth":2,"borderStyle":"outset","borderColor":"#767676","backgroundColor":"#efefef","color":"#000000","textAlign":"center","cursor":"default","fontFamily":".SystemUIFont","fontSize":"13.3333px","fontWeight":400,"fontStyle":"normal","lineHeight":"normal"}"##,
    ),
    // Chrome's `input[type=checkbox]` and `input[type=radio]`: the size is the control's default one.
    (
        "input[type=checkbox]",
        r#"{"display":"inline-block","boxSizing":"border-box","width":13,"height":13,"marginTop":3,"marginRight":3,"marginBottom":3,"marginLeft":4}"#,
    ),
    (
        "input[type=radio]",
        r#"{"display":"inline-block","boxSizing":"border-box","width":13,"height":13,"marginTop":3,"marginRight":3,"marginBottom":0,"marginLeft":5}"#,
    ),
    ("input[type=hidden]", r#"{"display":"none"}"#),
    // Chrome's slider: 129 by 16 with a 2px margin. The track and thumb are not painted (see `input_range`).
    (
        "input[type=range]",
        r#"{"display":"inline-block","width":129,"height":16,"marginTop":2,"marginRight":2,"marginBottom":2,"marginLeft":2}"#,
    ),
    ("table", r#"{"display":"table","borderSpacing":2}"#),
    ("thead", r#"{"display":"table-header-group"}"#),
    ("tbody", r#"{"display":"table-row-group"}"#),
    ("tfoot", r#"{"display":"table-footer-group"}"#),
    ("tr", r#"{"display":"table-row"}"#),
    ("td", r#"{"display":"table-cell","padding":1,"verticalAlign":"middle"}"#),
    ("th", r#"{"display":"table-cell","padding":1,"verticalAlign":"middle","fontWeight":700,"textAlign":"center"}"#),
    ("caption", r#"{"display":"table-caption","textAlign":"center"}"#),
    ("colgroup", r#"{"display":"table-column-group"}"#),
    ("col", r#"{"display":"table-column"}"#),
];
