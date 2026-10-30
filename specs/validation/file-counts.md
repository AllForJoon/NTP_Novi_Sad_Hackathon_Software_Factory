# UTF-8 file statistics CLI

Build a TypeScript CLI using Node built-ins only.
Run `node dist/index.js stats <path>` to read a UTF-8 text file and print one JSON
object followed by a newline: {"lines":number,"words":number,"characters":number}.
Characters count Unicode code points including whitespace and line endings.
Words are maximal runs of non-whitespace characters. Lines are LF-separated
records: empty input has zero lines; a final LF terminates the last record and
does not add an extra line. CRLF also separates lines, and both characters count.
An empty file succeeds with all zero counts. Blank lines still count as lines.
Require exactly the `stats` command and one path argument. Missing files,
directories, invalid paths, wrong command and wrong arity must produce a useful
stderr message, no stdout and a nonzero exit code. Paths with spaces must work.
No networking, dependencies, GUI, or persistence beyond reading the given file.
