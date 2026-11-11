//! CSS Syntax Level 3 tokens, enough for rules, selectors and declaration values.
//!
//! Strings and `url(...)` are single tokens, so a brace or semicolon inside one never reaches the
//! block scanner. A comment and the whitespace around it become one [`Kind::Whitespace`].

#[derive(Debug, Clone, PartialEq)]
pub(super) enum Kind {
    Whitespace,
    Ident(String),
    Function(String),
    AtKeyword(String),
    Hash { name: String, is_id: bool },
    Str(String),
    BadStr,
    Url,
    /// A number with no unit and no percent sign.
    Number,
    /// A number with a unit or a percent sign.
    Dimension,
    Colon,
    Semicolon,
    Comma,
    OpenParen,
    CloseParen,
    OpenBracket,
    CloseBracket,
    OpenBrace,
    CloseBrace,
    Delim(char),
}

impl Kind {
    pub(super) fn is_opener(&self) -> bool {
        matches!(self, Kind::OpenParen | Kind::OpenBracket | Kind::OpenBrace | Kind::Function(_))
    }

    pub(super) fn is_closer(&self) -> bool {
        matches!(self, Kind::CloseParen | Kind::CloseBracket | Kind::CloseBrace)
    }
}

/// Byte offsets into the source text.
#[derive(Debug, Clone)]
pub(super) struct Token {
    pub(super) kind: Kind,
    pub(super) start: usize,
    pub(super) end: usize,
}

pub(super) fn tokenize(src: &str) -> Vec<Token> {
    let mut tokenizer = Tokenizer {
        src,
        chars: src.chars().collect(),
        offsets: src.char_indices().map(|(offset, _)| offset).collect(),
        pos: 0,
        tokens: Vec::new(),
    };
    tokenizer.run();
    tokenizer.tokens
}

/// The index of the token that closes the opener at `open`, or `tokens.len()` when it never does.
/// A block ends only at its own closer: a closer that does not match the innermost open bracket is
/// an ordinary token (CSS Syntax 5.4.7), so a stray `)` does not end a rule early.
pub(super) fn find_close(tokens: &[Token], open: usize) -> usize {
    let mut open_brackets: Vec<&Kind> = Vec::new();
    for (index, token) in tokens.iter().enumerate().skip(open) {
        if token.kind.is_opener() {
            open_brackets.push(&token.kind);
        } else if token.kind.is_closer() {
            let matches_innermost = open_brackets.last().is_some_and(|innermost| closes(innermost, &token.kind));
            if matches_innermost {
                open_brackets.pop();
                if open_brackets.is_empty() {
                    return index;
                }
            }
        }
    }
    tokens.len()
}

fn closes(opener: &Kind, closer: &Kind) -> bool {
    matches!(
        (opener, closer),
        (Kind::OpenParen | Kind::Function(_), Kind::CloseParen)
            | (Kind::OpenBracket, Kind::CloseBracket)
            | (Kind::OpenBrace, Kind::CloseBrace)
    )
}

pub(super) fn trim(mut tokens: &[Token]) -> &[Token] {
    while tokens.first().is_some_and(|token| token.kind == Kind::Whitespace) {
        tokens = &tokens[1..];
    }
    while tokens.last().is_some_and(|token| token.kind == Kind::Whitespace) {
        tokens = &tokens[..tokens.len() - 1];
    }
    tokens
}

struct Tokenizer<'a> {
    src: &'a str,
    chars: Vec<char>,
    offsets: Vec<usize>,
    pos: usize,
    tokens: Vec<Token>,
}

fn is_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || !c.is_ascii()
}

fn is_name_char(c: char) -> bool {
    is_ident_start(c) || c.is_ascii_digit() || c == '-'
}

impl Tokenizer<'_> {
    fn peek(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.pos + ahead).copied()
    }

    fn offset(&self, index: usize) -> usize {
        self.offsets.get(index).copied().unwrap_or(self.src.len())
    }

    fn valid_escape(&self, ahead: usize) -> bool {
        self.peek(ahead) == Some('\\') && self.peek(ahead + 1).is_some_and(|c| c != '\n')
    }

    fn starts_ident(&self, ahead: usize) -> bool {
        match self.peek(ahead) {
            Some('-') => {
                self.peek(ahead + 1).is_some_and(|c| is_ident_start(c) || c == '-')
                    || self.valid_escape(ahead + 1)
            }
            Some('\\') => self.valid_escape(ahead),
            Some(c) => is_ident_start(c),
            None => false,
        }
    }

    fn starts_number(&self) -> bool {
        let digit_at = |ahead| self.peek(ahead).is_some_and(|c| c.is_ascii_digit());
        match self.peek(0) {
            Some(c) if c.is_ascii_digit() => true,
            Some('+' | '-') => digit_at(1) || (self.peek(1) == Some('.') && digit_at(2)),
            Some('.') => digit_at(1),
            _ => false,
        }
    }

    fn run(&mut self) {
        while let Some(c) = self.peek(0) {
            let start = self.pos;
            let kind = self.next_kind(c);
            self.tokens.push(Token { kind, start: self.offset(start), end: self.offset(self.pos) });
        }
    }

    fn next_kind(&mut self, c: char) -> Kind {
        if is_whitespace(c) || (c == '/' && self.peek(1) == Some('*')) {
            self.consume_whitespace();
            return Kind::Whitespace;
        }
        match c {
            '"' | '\'' => self.consume_string(c),
            '#' => {
                self.pos += 1;
                if self.peek(0).is_some_and(is_name_char) || self.valid_escape(0) {
                    let is_id = self.starts_ident(0);
                    Kind::Hash { name: self.consume_name(), is_id }
                } else {
                    Kind::Delim('#')
                }
            }
            '(' => self.single(Kind::OpenParen),
            ')' => self.single(Kind::CloseParen),
            '[' => self.single(Kind::OpenBracket),
            ']' => self.single(Kind::CloseBracket),
            '{' => self.single(Kind::OpenBrace),
            '}' => self.single(Kind::CloseBrace),
            ':' => self.single(Kind::Colon),
            ';' => self.single(Kind::Semicolon),
            ',' => self.single(Kind::Comma),
            '@' => {
                self.pos += 1;
                if self.starts_ident(0) {
                    Kind::AtKeyword(self.consume_name())
                } else {
                    Kind::Delim('@')
                }
            }
            _ if self.starts_number() => self.consume_number(),
            _ if self.starts_ident(0) => self.consume_ident_like(),
            _ => {
                self.pos += 1;
                Kind::Delim(c)
            }
        }
    }

    fn single(&mut self, kind: Kind) -> Kind {
        self.pos += 1;
        kind
    }

    fn consume_whitespace(&mut self) {
        while let Some(c) = self.peek(0) {
            if is_whitespace(c) {
                self.pos += 1;
            } else if c == '/' && self.peek(1) == Some('*') {
                self.pos += 2;
                while self.pos < self.chars.len() && !(self.peek(0) == Some('*') && self.peek(1) == Some('/')) {
                    self.pos += 1;
                }
                self.pos = (self.pos + 2).min(self.chars.len());
            } else {
                break;
            }
        }
    }

    /// The character after a consumed `\`.
    fn consume_escape(&mut self) -> char {
        let Some(first) = self.peek(0) else {
            return '\u{FFFD}';
        };
        if !first.is_ascii_hexdigit() {
            self.pos += 1;
            return first;
        }
        let mut code = 0u32;
        let mut digits = 0;
        while digits < 6 && self.peek(0).is_some_and(|c| c.is_ascii_hexdigit()) {
            code = code * 16 + self.peek(0).and_then(|c| c.to_digit(16)).expect("a hex digit");
            self.pos += 1;
            digits += 1;
        }
        if self.peek(0).is_some_and(is_whitespace) {
            self.pos += 1;
        }
        match char::from_u32(code) {
            Some(c) if code != 0 => c,
            _ => '\u{FFFD}',
        }
    }

    fn consume_name(&mut self) -> String {
        let mut name = String::new();
        while let Some(c) = self.peek(0) {
            if is_name_char(c) {
                name.push(c);
                self.pos += 1;
            } else if self.valid_escape(0) {
                self.pos += 1;
                name.push(self.consume_escape());
            } else {
                break;
            }
        }
        name
    }

    fn consume_string(&mut self, quote: char) -> Kind {
        self.pos += 1;
        let mut value = String::new();
        while let Some(c) = self.peek(0) {
            match c {
                _ if c == quote => {
                    self.pos += 1;
                    return Kind::Str(value);
                }
                '\n' => return Kind::BadStr,
                '\\' => {
                    self.pos += 1;
                    match self.peek(0) {
                        None => {}
                        Some('\n') => self.pos += 1,
                        Some(_) => value.push(self.consume_escape()),
                    }
                }
                _ => {
                    value.push(c);
                    self.pos += 1;
                }
            }
        }
        Kind::Str(value)
    }

    fn consume_number(&mut self) -> Kind {
        if matches!(self.peek(0), Some('+' | '-')) {
            self.pos += 1;
        }
        while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.peek(0) == Some('.') && self.peek(1).is_some_and(|c| c.is_ascii_digit()) {
            self.pos += 1;
            while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(0), Some('e' | 'E')) {
            let digit_at = |ahead| self.peek(ahead).is_some_and(|c| c.is_ascii_digit());
            let exponent = if digit_at(1) {
                1
            } else if matches!(self.peek(1), Some('+' | '-')) && digit_at(2) {
                2
            } else {
                0
            };
            if exponent > 0 {
                self.pos += exponent;
                while self.peek(0).is_some_and(|c| c.is_ascii_digit()) {
                    self.pos += 1;
                }
            }
        }
        if self.starts_ident(0) {
            self.consume_name();
            Kind::Dimension
        } else if self.peek(0) == Some('%') {
            self.pos += 1;
            Kind::Dimension
        } else {
            Kind::Number
        }
    }

    fn consume_ident_like(&mut self) -> Kind {
        let name = self.consume_name();
        if self.peek(0) != Some('(') {
            return Kind::Ident(name);
        }
        self.pos += 1;
        if name.eq_ignore_ascii_case("url") {
            let mut ahead = 0;
            while self.peek(ahead).is_some_and(is_whitespace) {
                ahead += 1;
            }
            if !matches!(self.peek(ahead), Some('"' | '\'')) {
                self.consume_url();
                return Kind::Url;
            }
        }
        Kind::Function(name)
    }

    fn consume_url(&mut self) {
        while let Some(c) = self.peek(0) {
            self.pos += if c == '\\' { 2 } else { 1 };
            if c == ')' {
                break;
            }
        }
        self.pos = self.pos.min(self.chars.len());
    }
}
