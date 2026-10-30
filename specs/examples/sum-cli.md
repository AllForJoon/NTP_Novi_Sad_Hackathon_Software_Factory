# Sum CLI

Create a TypeScript CLI using only Node.js built-in modules.

Command: `sum <a> <b>`

The program prints the numerical sum followed by a newline and exits with code 0.
Support positive numbers, negative numbers, zero and decimal numbers.
Exactly two operands are required after the `sum` command.
Reject empty or whitespace-only operands, non-numeric operands, NaN and Infinity.
Invalid input, a missing/unknown command, or the wrong number of operands must
write a helpful error to stderr and return a non-zero exit code.
