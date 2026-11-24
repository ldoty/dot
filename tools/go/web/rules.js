// The rules of Go the page and the scripts share: a board is an array of size*size points (0 empty,
// 1 black, 2 white), indexed y * size + x with x across from the left and y down from the top (as OGS
// numbers them). Plain ES5, no build step: the page loads it as a script (window.GoRules); the scripts and
// tests run it in a vm context (scripts/rules-node.mjs) so there is one copy of the rules.
(function (root) {
  var LETTERS = "abcdefghijklmnopqrstuvwxyz";
  var GTP = "ABCDEFGHJKLMNOPQRST"; // GTP skips I

  function empty(size) { var b = []; for (var i = 0; i < size * size; i++) b.push(0); return b; }

  function neighbors(i, size) {
    var x = i % size, y = (i - x) / size, out = [];
    if (x > 0) out.push(i - 1);
    if (x < size - 1) out.push(i + 1);
    if (y > 0) out.push(i - size);
    if (y < size - 1) out.push(i + size);
    return out;
  }

  /** The chain of stones at i and its liberties: { stones: [i…], liberties: [i…] } */
  function group(board, size, i) {
    var color = board[i], stones = [], libs = {}, seen = {}, stack = [i];
    if (!color) return { stones: [], liberties: [] };
    seen[i] = true;
    while (stack.length) {
      var p = stack.pop();
      stones.push(p);
      var ns = neighbors(p, size);
      for (var k = 0; k < ns.length; k++) {
        var n = ns[k];
        if (board[n] === 0) libs[n] = true;
        else if (board[n] === color && !seen[n]) { seen[n] = true; stack.push(n); }
      }
    }
    return { stones: stones, liberties: Object.keys(libs).map(Number) };
  }

  /**
   * Plays `color` (1 or 2) at i. -> { board, captured: [i…] }, or null when the move is illegal:
   * the point is taken, it retakes a ko (`ko`, the point just captured in a single-stone ko), or it's suicide.
   */
  function play(board, size, i, color, ko) {
    if (i < 0 || i >= size * size || board[i] !== 0 || i === ko) return null;
    var b = board.slice(), other = 3 - color, captured = [];
    b[i] = color;
    var ns = neighbors(i, size);
    for (var k = 0; k < ns.length; k++) {
      if (b[ns[k]] === other) {
        var g = group(b, size, ns[k]);
        if (!g.liberties.length) for (var s = 0; s < g.stones.length; s++) { b[g.stones[s]] = 0; captured.push(g.stones[s]); }
      }
    }
    if (!group(b, size, i).liberties.length) return null;
    return { board: b, captured: captured };
  }

  /** The ko point after a move at i that captured `captured`: set only when one stone took one stone */
  function koAfter(board, size, i, captured) {
    if (captured.length !== 1) return -1;
    var g = group(board, size, i);
    return g.stones.length === 1 && g.liberties.length === 1 ? captured[0] : -1;
  }

  /** OGS initial_state strings ("aqbp…": pairs of x,y letters) -> a board */
  function fromState(size, state) {
    var b = empty(size);
    [["black", 1], ["white", 2]].forEach(function (c) {
      var s = (state && state[c[0]]) || "";
      for (var k = 0; k + 1 < s.length; k += 2) b[LETTERS.indexOf(s[k + 1]) * size + LETTERS.indexOf(s[k])] = c[1];
    });
    return b;
  }

  /** i -> "E5" (GTP: columns A-T without I, rows counted from the bottom) */
  function gtp(i, size) { var x = i % size, y = (i - x) / size; return GTP[x] + (size - y); }
  /** "E5" -> i, "pass" -> -1 */
  function fromGtp(s, size) {
    if (!s || /^pass$/i.test(s)) return -1;
    var x = GTP.indexOf(s[0].toUpperCase()), y = size - parseInt(s.slice(1), 10);
    return x < 0 || y < 0 || y >= size ? -1 : y * size + x;
  }
  /** Chebyshev distance between two points */
  function dist(a, b, size) { return Math.max(Math.abs(a % size - b % size), Math.abs(Math.floor(a / size) - Math.floor(b / size))); }

  var GoRules = { empty: empty, neighbors: neighbors, group: group, play: play, koAfter: koAfter, fromState: fromState, gtp: gtp, fromGtp: fromGtp, dist: dist };
  root.GoRules = GoRules;
})(this);
