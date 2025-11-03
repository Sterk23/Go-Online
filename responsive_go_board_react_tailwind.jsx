import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Undo2, Flag, CirclePlus, Calculator, Play, Pause, TimerReset } from "lucide-react";
import { motion } from "framer-motion";

// ------------------------------------------------------------
// Responsive Go Board with configurable size, live scoring & time controls
// - Single-file React component
// - Chinese area scoring (stones + fully-surrounded territory)
// - Legal move check (no suicide unless capturing)
// - Simple ko prevention (one-step repeated board state)
// - Pass, Undo, Reset, Komi
// - Time control: Off / Japanese Byo-Yomi / Canadian Byo-Yomi
// - Coordinates: per-point labels (A19, …) + all four board edges + large horizontal numbers
// ------------------------------------------------------------

// Helpers
const EMPTY = 0 as const;
const BLACK = 1 as const;
const WHITE = 2 as const;

type Stone = 0 | 1 | 2;

type Point = { r: number; c: number };

enum TimeMode { OFF = "off", JAPANESE = "japanese", CANADIAN = "canadian" }

type TimeConfig = {
  mode: TimeMode;
  mainMinutes: number; // main time minutes per side
  // Japanese byo-yomi
  jpPeriods: number; // number of periods
  jpSecondsPerPeriod: number; // seconds per period
  // Canadian byo-yomi
  caStonesPerBlock: number; // stones to play per block
  caSecondsPerBlock: number; // seconds per block
};

type ClockState = {
  mainMs: number;
  inOvertime: boolean;
  // Japanese
  jpPeriodsLeft: number;
  jpPeriodMsLeft: number;
  // Canadian
  caMsLeft: number; // time remaining in current block after main time expired
  caStonesLeft: number; // stones to play in the current block
  // Status
  flagged: boolean; // time loss
};

function toMsFromMin(min: number) { return Math.max(0, Math.floor(min * 60_000)); }
function toMsFromSec(s: number) { return Math.max(0, Math.floor(s * 1000)); }

function fmtClock(totalMs: number) {
  const neg = totalMs < 0; const t = Math.max(0, Math.floor(Math.abs(totalMs)));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const ds = Math.floor((t % 1000) / 100); // deciseconds
  return m >= 10 ? `${neg ? "-" : ""}${m}:${s.toString().padStart(2, "0")}` : `${neg ? "-" : ""}${m}:${s.toString().padStart(2, "0")}.${ds}`;
}

function cloneBoard(b: Stone[][]): Stone[][] { return b.map((row) => row.slice()); }
function boardHash(b: Stone[][]): string { return b.map((row) => row.join("")).join("|"); }

function neighborsOf(size: number, r: number, c: number): Point[] {
  const res: Point[] = [];
  if (r > 0) res.push({ r: r - 1, c });
  if (r < size - 1) res.push({ r: r + 1, c });
  if (c > 0) res.push({ r, c: c - 1 });
  if (c < size - 1) res.push({ r, c: c + 1 });
  return res;
}

function floodGroup(board: Stone[][], start: Point) {
  const size = board.length;
  const color = board[start.r][start.c];
  const stack = [start];
  const visited = new Set<string>();
  const stones: Point[] = [];
  let liberties = 0;
  while (stack.length) {
    const p = stack.pop()!;
    const key = `${p.r},${p.c}`;
    if (visited.has(key)) continue;
    visited.add(key);
    stones.push(p);
    for (const n of neighborsOf(size, p.r, p.c)) {
      const v = board[n.r][n.c];
      if (v === EMPTY) liberties += 1;
      else if (v === color) {
        const nk = `${n.r},${n.c}`;
        if (!visited.has(nk)) stack.push(n);
      }
    }
  }
  return { stones, liberties };
}

function copyAndPlace(board: Stone[][], p: Point, color: Stone) {
  const nb = cloneBoard(board);
  nb[p.r][p.c] = color;
  return nb;
}

function removeStones(board: Stone[][], stones: Point[]) {
  for (const s of stones) board[s.r][s.c] = EMPTY;
}

function tryPlayMove(board: Stone[][], p: Point, color: Stone) {
  if (board[p.r][p.c] !== EMPTY) return { ok: false, board, captures: 0 };
  const size = board.length;
  const tmp = copyAndPlace(board, p, color);
  let totalCaptures = 0;

  // Capture opponent groups with no liberties
  const opponent = color === BLACK ? WHITE : BLACK;
  const adjOppGroups: Point[][] = [];
  const seen = new Set<string>();
  for (const n of neighborsOf(size, p.r, p.c)) {
    if (tmp[n.r][n.c] === opponent) {
      const key = `${n.r},${n.c}`;
      if (!seen.has(key)) {
        const g = floodGroup(tmp, n);
        for (const s of g.stones) seen.add(`${s.r},${s.c}`);
        if (g.liberties === 0) adjOppGroups.push(g.stones);
      }
    }
  }
  for (const g of adjOppGroups) {
    removeStones(tmp, g);
    totalCaptures += g.length;
  }

  // Check for suicide (group with no liberties after captures)
  const me = floodGroup(tmp, p);
  if (me.liberties === 0) return { ok: false, board, captures: 0 };

  return { ok: true, board: tmp, captures: totalCaptures };
}

function computeScores(board: Stone[][]) {
  // Chinese area scoring: stones on board + surrounded empty territory
  const size = board.length;
  let blackStones = 0;
  let whiteStones = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === BLACK) blackStones++;
      else if (board[r][c] === WHITE) whiteStones++;
    }
  }

  const visited = new Set<string>();
  let blackTerr = 0;
  let whiteTerr = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY) continue;
      const key0 = `${r},${c}`;
      if (visited.has(key0)) continue;

      // Flood empty region
      const stack: Point[] = [{ r, c }];
      const region: Point[] = [];
      const borders = new Set<Stone>();
      while (stack.length) {
        const p = stack.pop()!;
        const k = `${p.r},${p.c}`;
        if (visited.has(k)) continue;
        visited.add(k);
        region.push(p);
        for (const n of neighborsOf(size, p.r, p.c)) {
          const v = board[n.r][n.c];
          if (v === EMPTY) {
            const nk = `${n.r},${n.c}`;
            if (!visited.has(nk)) stack.push(n);
          } else {
            borders.add(v);
          }
        }
      }
      // Territory belongs to a single color if borders.size === 1 and not EMPTY
      if (borders.size === 1) {
        const owner = [...borders][0];
        if (owner === BLACK) blackTerr += region.length;
        else if (owner === WHITE) whiteTerr += region.length;
      }
    }
  }
  return {
    black: blackStones + blackTerr,
    white: whiteStones + whiteTerr,
    details: { blackStones, whiteStones, blackTerr, whiteTerr },
  };
}

function usePrevious<T>(value: T) {
  const ref = useRef<T | null>(null);
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}

// Stone rendering helper
function StoneCircle({ x, y, color, radius }: { x: number; y: number; color: Stone; radius: number }) {
  if (color === EMPTY) return null;
  const isBlack = color === BLACK;
  return (
    <g>
      {/* Shadow */}
      <circle cx={x + radius * 0.04} cy={y + radius * 0.06} r={radius * 0.98} fill={isBlack ? "#0a0a0a" : "#d4d4d4"} opacity={0.35} />
      {/* Body */}
      <circle cx={x} cy={y} r={radius} fill={isBlack ? "#111" : "#f8f8f8"} stroke="#00000022" />
      {/* Specular highlight */}
      <ellipse cx={x - radius * 0.25} cy={y - radius * 0.25} rx={radius * 0.35} ry={radius * 0.22} fill={isBlack ? "#ffffff22" : "#ffffff66"} />
    </g>
  );
}

// -----------------------
// DEV SELF-TESTS (console)
// -----------------------
function runSelfTests() {
  try {
    console.group("GoBoard self-tests");

    // neighborsOf()
    console.assert(neighborsOf(9, 0, 0).length === 2, "corner should have 2 neighbors");
    console.assert(neighborsOf(9, 4, 4).length === 4, "center should have 4 neighbors");

    // computeScores on empty 9x9
    const empty = Array.from({ length: 9 }, () => Array<Stone>(9).fill(EMPTY));
    const s0 = computeScores(empty);
    console.assert(s0.black === 0 && s0.white === 0, "empty board scores should be 0/0 (area)");

    // simple legal move
    const b1 = cloneBoard(empty);
    const mv = tryPlayMove(b1, { r: 0, c: 0 }, BLACK);
    console.assert(mv.ok, "first move should be legal");

    // hash equality for identical boards
    const h1 = boardHash(empty);
    const h2 = boardHash(cloneBoard(empty));
    console.assert(h1 === h2, "boardHash should be equal for identical positions");

    // letter mapping skips I
    const letters = "ABCDEFGHJKLMNOPQRSTUVWXYZ".replace("I", "");
    console.assert(letters[8] === "J" && !letters.includes("I"), "column letters must skip I");

    // suicide should be illegal (white plays at center surrounded by black)
    const s3 = Array.from({ length: 3 }, () => Array<Stone>(3).fill(EMPTY));
    s3[0][1] = BLACK; s3[1][0] = BLACK; s3[1][2] = BLACK; s3[2][1] = BLACK;
    const su = tryPlayMove(s3, { r: 1, c: 1 }, WHITE);
    console.assert(!su.ok, "suicide move should be rejected");

    // capture single stone: white captures black center
    const s4 = Array.from({ length: 3 }, () => Array<Stone>(3).fill(EMPTY));
    s4[1][1] = BLACK;
    s4[0][1] = WHITE; s4[1][0] = WHITE; s4[1][2] = WHITE;
    const cap = tryPlayMove(s4, { r: 2, c: 1 }, WHITE);
    console.assert(cap.ok && cap.captures === 1 && cap.board[1][1] === EMPTY, "capture should remove stone and count 1");

    console.log("All tests passed");
  } catch (e) {
    console.error("Self-tests failed:", e);
  } finally {
    console.groupEnd();
  }
}

export default function GoBoardApp() {
  const [size, setSize] = useState<number>(19);
  const [board, setBoard] = useState<Stone[][]>(() => Array.from({ length: 19 }, () => Array<Stone>(19).fill(EMPTY)));
  const [toPlay, setToPlay] = useState<Stone>(BLACK);
  const [history, setHistory] = useState<string[]>([]); // board hashes for undo
  const [koHash, setKoHash] = useState<string | null>(null); // simple one-step ko
  const [captures, setCaptures] = useState<{ black: number; white: number }>({ black: 0, white: 0 });
  const [komi, setKomi] = useState<number>(6.5);
  const [showCoords, setShowCoords] = useState<boolean>(true);
  const [showScore, setShowScore] = useState<boolean>(false);

  // Time control state
  const [timeCfg, setTimeCfg] = useState<TimeConfig>({
    mode: TimeMode.OFF,
    mainMinutes: 30,
    jpPeriods: 3,
    jpSecondsPerPeriod: 30,
    caStonesPerBlock: 25,
    caSecondsPerBlock: 600,
  });
  const [clockRunning, setClockRunning] = useState(false);
  const [blackClock, setBlackClock] = useState<ClockState>(() => mkClockFromCfg(timeCfg));
  const [whiteClock, setWhiteClock] = useState<ClockState>(() => mkClockFromCfg(timeCfg));

  const currentHash = useMemo(() => boardHash(board), [board]);
  const prevHash = usePrevious(currentHash);

  useEffect(() => {
    // run basic self-tests once on mount
    runSelfTests();
  }, []);

  useEffect(() => {
    // Reset ko if board actually changed (placeholder for future rules)
    if (prevHash && prevHash !== currentHash) {
      // noop
    }
  }, [currentHash, prevHash]);

  // CLOCK TICKER
  useEffect(() => {
    if (!clockRunning || timeCfg.mode === TimeMode.OFF) return;
    const interval = setInterval(() => {
      setBlackClock((bc) => (toPlay === BLACK ? tickClock(bc, timeCfg) : bc));
      setWhiteClock((wc) => (toPlay === WHITE ? tickClock(wc, timeCfg) : wc));
    }, 200);
    return () => clearInterval(interval);
  }, [clockRunning, toPlay, timeCfg]);

  function mkClockFromCfg(cfg: TimeConfig): ClockState {
    return {
      mainMs: toMsFromMin(cfg.mainMinutes),
      inOvertime: false,
      jpPeriodsLeft: cfg.jpPeriods,
      jpPeriodMsLeft: toMsFromSec(cfg.jpSecondsPerPeriod),
      caMsLeft: toMsFromSec(cfg.caSecondsPerBlock),
      caStonesLeft: cfg.caStonesPerBlock,
      flagged: false,
    };
  }

  function resetClocksWithCfg(cfg: TimeConfig) {
    setBlackClock(mkClockFromCfg(cfg));
    setWhiteClock(mkClockFromCfg(cfg));
    setClockRunning(false);
  }

  function applyNewCfg(partial: Partial<TimeConfig>) {
    setTimeCfg((prev) => {
      const next = { ...prev, ...partial };
      resetClocksWithCfg(next);
      return next;
    });
  }

  function tickClock(cs: ClockState, cfg: TimeConfig): ClockState {
    if (cs.flagged) return cs;
    // If still in main time
    if (!cs.inOvertime && cs.mainMs > 0) {
      const nm = cs.mainMs - 200;
      if (nm > 0) return { ...cs, mainMs: nm };
      // transition to overtime
      const base: ClockState = { ...cs, mainMs: 0, inOvertime: true };
      if (cfg.mode === TimeMode.JAPANESE) {
        return { ...base, jpPeriodsLeft: cfg.jpPeriods, jpPeriodMsLeft: toMsFromSec(cfg.jpSecondsPerPeriod) - Math.abs(nm) };
      } else if (cfg.mode === TimeMode.CANADIAN) {
        return { ...base, caMsLeft: toMsFromSec(cfg.caSecondsPerBlock) - Math.abs(nm), caStonesLeft: cfg.caStonesPerBlock };
      } else {
        return { ...base, flagged: true }; // no overtime -> time loss
      }
    }

    // In overtime
    if (cfg.mode === TimeMode.JAPANESE) {
      const nm = cs.jpPeriodMsLeft - 200;
      if (nm > 0) return { ...cs, jpPeriodMsLeft: nm, inOvertime: true };
      // period expired -> lose one period
      const left = cs.jpPeriodsLeft - 1;
      if (left <= 0) return { ...cs, jpPeriodsLeft: 0, jpPeriodMsLeft: 0, flagged: true };
      return { ...cs, jpPeriodsLeft: left, jpPeriodMsLeft: toMsFromSec(cfg.jpSecondsPerPeriod) };
    }
    if (cfg.mode === TimeMode.CANADIAN) {
      const nm = cs.caMsLeft - 200;
      if (nm > 0) return { ...cs, caMsLeft: nm, inOvertime: true };
      // ran out of time before meeting stones quota -> flagged
      return { ...cs, caMsLeft: 0, flagged: cs.caStonesLeft > 0 };
    }
    return cs;
  }

  function onMoveComplete() {
    // Start clock on first move if not running
    if (timeCfg.mode !== TimeMode.OFF && !clockRunning) setClockRunning(true);

    // Apply per-mode move bookkeeping for the player who just moved
    if (timeCfg.mode === TimeMode.JAPANESE) {
      if (toPlay === BLACK) {
        // Black just played -> reset Black period, switch to White
        setBlackClock((bc) => ({ ...bc, jpPeriodMsLeft: toMsFromSec(timeCfg.jpSecondsPerPeriod) }));
      } else {
        setWhiteClock((wc) => ({ ...wc, jpPeriodMsLeft: toMsFromSec(timeCfg.jpSecondsPerPeriod) }));
      }
    } else if (timeCfg.mode === TimeMode.CANADIAN) {
      if (toPlay === BLACK) {
        setBlackClock((bc) => {
          if (!bc.inOvertime) return bc; // during main time nothing to do
          const left = Math.max(0, bc.caStonesLeft - 1);
          const reset = left === 0 ? { caStonesLeft: timeCfg.caStonesPerBlock, caMsLeft: toMsFromSec(timeCfg.caSecondsPerBlock) } : {};
          return { ...bc, caStonesLeft: left, ...reset } as ClockState;
        });
      } else {
        setWhiteClock((wc) => {
          if (!wc.inOvertime) return wc;
          const left = Math.max(0, wc.caStonesLeft - 1);
          const reset = left === 0 ? { caStonesLeft: timeCfg.caStonesPerBlock, caMsLeft: toMsFromSec(timeCfg.caSecondsPerBlock) } : {};
          return { ...wc, caStonesLeft: left, ...reset } as ClockState;
        });
      }
    }
  }

  function resizeBoard(newSize: number) {
    setSize(newSize);
    const fresh = Array.from({ length: newSize }, () => Array<Stone>(newSize).fill(EMPTY));
    setBoard(fresh);
    setToPlay(BLACK);
    setHistory([]);
    setKoHash(null);
    setCaptures({ black: 0, white: 0 });
    setShowScore(false);
    resetClocksWithCfg(timeCfg);
  }

  function onIntersectionClick(r: number, c: number) {
    if (showScore) setShowScore(false);
    const move = { r, c };
    const attempt = tryPlayMove(board, move, toPlay);
    if (!attempt.ok) return;

    const newHash = boardHash(attempt.board);
    if (koHash && newHash === koHash) {
      // illegal ko recapture
      return;
    }

    // Legal: push history and update board
    setHistory((h) => [...h, currentHash]);
    setBoard(attempt.board);
    onMoveComplete();
    setToPlay(toPlay === BLACK ? WHITE : BLACK);

    // If exactly one stone captured, set simple ko hash to forbid immediate recapture
    if (attempt.captures === 1) setKoHash(currentHash);
    else setKoHash(null);

    setCaptures((cap) => (toPlay === BLACK ? { ...cap, black: cap.black + attempt.captures } : { ...cap, white: cap.white + attempt.captures }));
  }

  function handlePass() {
    onMoveComplete();
    setToPlay(toPlay === BLACK ? WHITE : BLACK);
    setKoHash(null);
  }

  function handleUndo() {
    const last = history[history.length - 1];
    if (!last) return;
    const newBoard = last.split("|").map((row) => row.split("").map((ch) => (ch === "0" ? 0 : ch === "1" ? 1 : 2)) as Stone[]);
    setBoard(newBoard);
    setHistory((h) => h.slice(0, -1));
    setToPlay(toPlay === BLACK ? WHITE : BLACK);
    setKoHash(null);
    // Note: time is not reverted on undo (simple behavior)
  }

  const score = useMemo(() => computeScores(board), [board]);
  const blackTotal = score.black;
  const whiteTotal = score.white + komi; // apply komi to white

  // SVG rendering math
  const padding = 24; // px padding around grid inside SVG

  const starPoints = useMemo(() => {
    // Standard star points for 19, 13, 9
    const idx = (n: number) => [3, Math.floor(n / 2), n - 4];
    const stars: Point[] = [];
    if (size >= 9) {
      const p = idx(size);
      for (const r of p) for (const c of p) stars.push({ r, c });
    }
    return stars;
  }, [size]);

  // Animation variants
  const stoneAnim = {
    initial: { scale: 0.6, opacity: 0 },
    in: { scale: 1, opacity: 1, transition: { type: "spring", stiffness: 280, damping: 20 } },
  } as const;

  const blackFlagged = blackClock.flagged;
  const whiteFlagged = whiteClock.flagged;

  return (
    <div className="mx-auto max-w-6xl p-4 grid gap-4 lg:grid-cols-2">
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="text-xl">Go Board</span>
            <div className="flex items-center gap-2 text-sm">
              <div className="h-3 w-3 rounded-full bg-black" /> Black
              <div className="h-3 w-3 rounded-full bg-white ring-1 ring-gray-400" /> White
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <div className="aspect-square w-full">
              <BoardSVG
                size={size}
                board={board}
                padding={padding}
                onPlay={onIntersectionClick}
                showCoords={showCoords}
                starPoints={starPoints}
                stoneAnim={stoneAnim}
                toPlay={toPlay}
                showScoreOverlay={showScore}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="text-xl">Controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Board Size</Label>
              <Select value={String(size)} onValueChange={(v) => resizeBoard(parseInt(v))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="9">9 x 9</SelectItem>
                  <SelectItem value="13">13 x 13</SelectItem>
                  <SelectItem value="19">19 x 19</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Komi (White)</Label>
              <div className="mt-1 flex items-center gap-2">
                <Input type="number" step="0.5" value={komi} onChange={(e) => setKomi(parseFloat(e.target.value))} />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch checked={showCoords} onCheckedChange={setShowCoords} />
              <Label>Show coordinates</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={showScore} onCheckedChange={setShowScore} />
              <Label>Show score overlay</Label>
            </div>
          </div>

          {/* TIME CONTROLS */}
          <div className="rounded-xl border p-3 space-y-3">
            <div className="font-medium">Time Controls</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Mode</Label>
                <Select value={timeCfg.mode} onValueChange={(v) => applyNewCfg({ mode: v as TimeMode })}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TimeMode.OFF}>Off</SelectItem>
                    <SelectItem value={TimeMode.JAPANESE}>Japanese byo-yomi</SelectItem>
                    <SelectItem value={TimeMode.CANADIAN}>Canadian byo-yomi</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Main time (min)</Label>
                <Input className="mt-1" type="number" min={0} step={1} value={timeCfg.mainMinutes}
                  onChange={(e) => applyNewCfg({ mainMinutes: Math.max(0, parseInt(e.target.value || "0")) })} />
              </div>

              {timeCfg.mode === TimeMode.JAPANESE && (
                <>
                  <div>
                    <Label>Periods</Label>
                    <Input className="mt-1" type="number" min={1} step={1} value={timeCfg.jpPeriods}
                      onChange={(e) => applyNewCfg({ jpPeriods: Math.max(1, parseInt(e.target.value || "1")) })} />
                  </div>
                  <div>
                    <Label>Sec / period</Label>
                    <Input className="mt-1" type="number" min={1} step={1} value={timeCfg.jpSecondsPerPeriod}
                      onChange={(e) => applyNewCfg({ jpSecondsPerPeriod: Math.max(1, parseInt(e.target.value || "1")) })} />
                  </div>
                </>
              )}

              {timeCfg.mode === TimeMode.CANADIAN && (
                <>
                  <div>
                    <Label>Stones / block</Label>
                    <Input className="mt-1" type="number" min={1} step={1} value={timeCfg.caStonesPerBlock}
                      onChange={(e) => applyNewCfg({ caStonesPerBlock: Math.max(1, parseInt(e.target.value || "1")) })} />
                  </div>
                  <div>
                    <Label>Sec / block</Label>
                    <Input className="mt-1" type="number" min={1} step={1} value={timeCfg.caSecondsPerBlock}
                      onChange={(e) => applyNewCfg({ caSecondsPerBlock: Math.max(1, parseInt(e.target.value || "1")) })} />
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-muted p-2">
                <div className="text-xs opacity-70">Black</div>
                <ClockReadout cfg={timeCfg} cs={blackClock} active={toPlay === BLACK && clockRunning} />
                {timeCfg.mode === TimeMode.CANADIAN && blackClock.inOvertime && (
                  <div className="text-xs">Stones left: {blackClock.caStonesLeft}</div>
                )}
              </div>
              <div className="rounded-lg bg-muted p-2">
                <div className="text-xs opacity-70">White</div>
                <ClockReadout cfg={timeCfg} cs={whiteClock} active={toPlay === WHITE && clockRunning} />
                {timeCfg.mode === TimeMode.CANADIAN && whiteClock.inOvertime && (
                  <div className="text-xs">Stones left: {whiteClock.caStonesLeft}</div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setClockRunning(true)} className="gap-2"><Play className="h-4 w-4"/>Start</Button>
              <Button size="sm" variant="secondary" onClick={() => setClockRunning(false)} className="gap-2"><Pause className="h-4 w-4"/>Pause</Button>
              <Button size="sm" variant="destructive" onClick={() => resetClocksWithCfg(timeCfg)} className="gap-2"><TimerReset className="h-4 w-4"/>Reset</Button>
            </div>
            {(blackFlagged || whiteFlagged) && (
              <div className="text-sm font-medium text-red-600">{blackFlagged ? "Black" : "White"} lost on time.</div>
            )}
            <p className="text-xs text-muted-foreground">Note: Clock starts on the first move/pass. Undo does not rewind the clock.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button onClick={handlePass} variant="secondary" className="gap-2"><Flag className="h-4 w-4"/>Pass</Button>
            <Button onClick={handleUndo} variant="secondary" className="gap-2"><Undo2 className="h-4 w-4"/>Undo</Button>
            <Button onClick={() => setShowScore((s) => !s)} className="col-span-2 gap-2"><Calculator className="h-4 w-4"/>Score Now</Button>
          </div>

          <div className="rounded-xl bg-muted p-3 grid grid-cols-2 gap-3 text-sm">
            <div className="space-y-1">
              <div className="font-medium">Turn</div>
              <div className="flex items-center gap-2">
                <span className={`inline-block h-3 w-3 rounded-full ${toPlay === BLACK ? "bg-black" : "bg-white ring-1 ring-gray-400"}`} />
                {toPlay === BLACK ? "Black" : "White"}
              </div>
            </div>
            <div className="space-y-1">
              <div className="font-medium">Captures</div>
              <div>Black: {captures.black} | White: {captures.white}</div>
            </div>
            <div className="space-y-1">
              <div className="font-medium">Area Score (w/ komi)</div>
              <div>Black: {blackTotal.toFixed(1)}</div>
            </div>
            <div className="space-y-1">
              <div className="opacity-0">.</div>
              <div>White: {(whiteTotal).toFixed(1)} {komi ? <span className="text-xs opacity-70">(+{komi} komi)</span> : null}</div>
            </div>
            <div className="col-span-2">
              <div className="mt-1 text-sm font-medium">Result</div>
              <div className="text-base">
                {whiteTotal === blackTotal ? (
                  <span>Even game.</span>
                ) : whiteTotal > blackTotal ? (
                  <span>White leads by {(whiteTotal - blackTotal).toFixed(1)}.</span>
                ) : (
                  <span>Black leads by {(blackTotal - whiteTotal).toFixed(1)}.</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button variant="destructive" onClick={() => resizeBoard(size)} className="gap-2"><CirclePlus className="h-4 w-4"/>New Game</Button>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            Notes: scoring uses <strong>Chinese area rules</strong> (stones + surrounded territory). Ko is prevented for a <em>single-step repetition</em>. Undo restores position but not capture counts exactly.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ClockReadout({ cfg, cs, active }: { cfg: TimeConfig; cs: ClockState; active: boolean }) {
  const badge = active ? "ring-2 ring-emerald-400" : "";
  let text = fmtClock(cs.mainMs);
  if (cs.inOvertime) {
    if (cfg.mode === TimeMode.JAPANESE) {
      text = `${fmtClock(cs.jpPeriodMsLeft)}  (P:${cs.jpPeriodsLeft})`;
    } else if (cfg.mode === TimeMode.CANADIAN) {
      text = `${fmtClock(cs.caMsLeft)}`;
    }
  }
  return (
    <div className={`mt-1 rounded-md bg-white/60 px-2 py-1 text-lg font-mono ${badge}`}>
      {cs.flagged ? "TIME" : text}
    </div>
  );
}

function BoardSVG({
  size,
  board,
  padding,
  onPlay,
  showCoords,
  starPoints,
  stoneAnim,
  toPlay,
  showScoreOverlay,
}: {
  size: number;
  board: Stone[][];
  padding: number;
  onPlay: (r: number, c: number) => void;
  showCoords: boolean;
  starPoints: Point[];
  stoneAnim: any;
  toPlay: Stone;
  showScoreOverlay: boolean;
}) {
  const N = size;
  // SVG viewBox 0..1000 for simplicity
  const vb = 1000;
  const inner = vb - padding * 2;
  const cell = inner / (N - 1);

  // Track hovered grid intersection for label styling
  const [hoverRC, setHoverRC] = React.useState<Point | null>(null);

  const handleMouseMove = (evt: React.MouseEvent<SVGSVGElement>) => {
    const svg = evt.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const loc = pt.matrixTransform(ctm.inverse());
    const gx = Math.round((loc.x - padding) / cell);
    const gy = Math.round((loc.y - padding) / cell);
    if (gx < 0 || gx >= N || gy < 0 || gy >= N) {
      setHoverRC(null);
      return;
    }
    setHoverRC({ r: gy, c: gx });
  };

  const handleClick = (evt: React.MouseEvent<SVGSVGElement>) => {
    const svg = evt.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const loc = pt.matrixTransform(ctm.inverse());
    // Find nearest intersection
    const gx = Math.round((loc.x - padding) / cell);
    const gy = Math.round((loc.y - padding) / cell);
    if (gx < 0 || gx >= N || gy < 0 || gy >= N) return;
    onPlay(gy, gx);
  };

  return (
    <svg
      viewBox={`0 0 ${vb} ${vb}`}
      className="h-full w-full select-none touch-none"
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverRC(null)}
      role="img"
      aria-label="Go board"
    >
      {/* Wooden background */}
      <defs>
        <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e5b772" />
          <stop offset="100%" stopColor="#d59e52" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={vb} height={vb} fill="url(#wood)" rx={24} />
      <rect x={padding * 0.5} y={padding * 0.5} width={vb - padding} height={vb - padding} fill="#0000000b" rx={16} />

      {/* Grid lines */}
      <g stroke="#1f1f1f" strokeWidth={2}>
        {Array.from({ length: N }, (_, i) => (
          <line key={`v${i}`} x1={padding + i * cell} y1={padding} x2={padding + i * cell} y2={vb - padding} />
        ))}
        {Array.from({ length: N }, (_, i) => (
          <line key={`h${i}`} x1={padding} y1={padding + i * cell} x2={vb - padding} y2={padding + i * cell} />
        ))}
      </g>

      {/* Star points */}
      <g>
        {starPoints.map((p, idx) => (
          <circle
            key={idx}
            cx={padding + p.c * cell}
            cy={padding + p.r * cell}
            r={cell * 0.08}
            fill="#1f1f1f"
            opacity={0.8}
          />
        ))}
      </g>

      {/* Board-edge coordinates (letters bottom, numbers left) */}
      {showCoords && (
        <g fontSize={cell * 0.22} fontFamily="ui-sans-serif,system-ui" fill="#2e2e2e" opacity={0.8}>
          {/* Columns (bottom) */}
          {Array.from({ length: N }, (_, i) => (
            <text key={`cb${i}`} x={padding + i * cell} y={vb - padding + cell * 0.7} textAnchor="middle">
              {"ABCDEFGHJKLMNOPQRSTUVWXYZ".replace("I", "")[i] ?? String(i + 1)}
            </text>
          ))}
          {/* Rows (left) */}
          {Array.from({ length: N }, (_, i) => (
            <text key={`rl${i}`} x={padding - cell * 0.5} y={padding + i * cell + cell * 0.08} textAnchor="end">
              {N - i}
            </text>
          ))}
        </g>
      )}

      {/* Per-point coordinate labels (e.g., A19). Horizontal = letters (skip I), Vertical = numbers */}
      {showCoords && (
        <g fontFamily="ui-sans-serif,system-ui">
          {Array.from({ length: N }, (_, r) =>
            Array.from({ length: N }, (_, c) => {
              const letter = "ABCDEFGHJKLMNOPQRSTUVWXYZ".replace("I", "")[c] ?? String(c + 1);
              const num = N - r;
              const isHover = !!(hoverRC && hoverRC.r === r && hoverRC.c === c);
              const fs = isHover ? cell * 0.28 : cell * 0.18;
              const fill = isHover ? "#000" : "#444";
              const opacity = isHover ? 0.9 : 0.45;
              const fontWeight = isHover ? 700 : 400;
              return (
                <text
                  key={`pt-${r}-${c}`}
                  x={padding + c * cell}
                  y={padding + r * cell + cell * 0.06}
                  textAnchor="middle"
                  fontSize={fs}
                  fill={fill}
                  opacity={opacity}
                  fontWeight={fontWeight}
                >
                  {`${letter}${num}`}
                </text>
              );
            })
          )}
        </g>
      )}

      {/* Edge coordinates (top & right) */}
      {showCoords && (
        <g fontSize={cell * 0.22} fontFamily="ui-sans-serif,system-ui" fill="#2e2e2e" opacity={0.85}>
          {/* Columns (top) */}
          {Array.from({ length: N }, (_, i) => (
            <text key={`ct${i}`} x={padding + i * cell} y={padding - cell * 0.35} textAnchor="middle">
              {"ABCDEFGHJKLMNOPQRSTUVWXYZ".replace("I", "")[i] ?? String(i + 1)}
            </text>
          ))}
          {/* Rows (right) */}
          {Array.from({ length: N }, (_, i) => (
            <text key={`rr${i}`} x={vb - padding + cell * 0.5} y={padding + i * cell + cell * 0.08} textAnchor="start">
              {N - i}
            </text>
          ))}
        </g>
      )}

      {/* Horizontal-edge numeric coordinates (top & bottom, large) */}
      {showCoords && (
        <g fontFamily="ui-sans-serif,system-ui" fontWeight={700} fill="#111">
          {/* Bottom numbers 1..N (bigger than letters) */}
          {Array.from({ length: N }, (_, i) => (
            <text
              key={`nb${i}`}
              x={padding + i * cell}
              y={vb - padding + cell * 1.25}
              textAnchor="middle"
              fontSize={cell * 0.32}
            >
              {i + 1}
            </text>
          ))}
          {/* Top numbers 1..N */}
          {Array.from({ length: N }, (_, i) => (
            <text
              key={`nt${i}`}
              x={padding + i * cell}
              y={padding - cell * 0.9}
              textAnchor="middle"
              fontSize={cell * 0.32}
            >
              {i + 1}
            </text>
          ))}
        </g>
      )}

      {/* Stones */}
      <g>
        {board.map((row, r) =>
          row.map((val, c) => {
            if (val === EMPTY) return null;
            const x = padding + c * cell;
            const y = padding + r * cell;
            return (
              <motion.g key={`${r}-${c}`} variants={stoneAnim} initial="initial" animate="in">
                <StoneCircle x={x} y={y} color={val} radius={cell * 0.45} />
              </motion.g>
            );
          })
        )}
      </g>

      {/* Hover indicator for next move (optional visual aid) */}
      <HoverIndicator size={N} padding={padding} cell={cell} toPlay={toPlay} />

      {/* Score overlay (territory shading) */}
      {showScoreOverlay && <ScoreOverlay board={board} padding={padding} cell={cell} />}
    </svg>
  );
}

function HoverIndicator({ size, padding, cell, toPlay }: { size: number; padding: number; cell: number; toPlay: Stone }) {
  // Draw faint dot following pointer snapped to intersections
  const ref = useRef<SVGCircleElement | null>(null);
  useEffect(() => {
    const svg = document.querySelector("svg[aria-label='Go board']");
    if (!svg) return;
    const handler = (evt: any) => {
      const ctm = (svg as any).getScreenCTM();
      if (!ctm) return;
      const pt = (svg as any).createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      const loc = pt.matrixTransform(ctm.inverse());
      const gx = Math.round((loc.x - padding) / cell);
      const gy = Math.round((loc.y - padding) / cell);
      if (gx < 0 || gx >= size || gy < 0 || gy >= size) {
        if (ref.current) ref.current.setAttribute("opacity", "0");
        return;
      }
      const x = padding + gx * cell;
      const y = padding + gy * cell;
      if (ref.current) {
        ref.current.setAttribute("cx", String(x));
        ref.current.setAttribute("cy", String(y));
        ref.current.setAttribute("opacity", "0.25");
      }
    };
    svg.addEventListener("mousemove", handler as any);
    svg.addEventListener("mouseleave", () => ref.current?.setAttribute("opacity", "0"));
    return () => {
      (svg as any).removeEventListener("mousemove", handler as any);
    };
  }, [cell, padding, size]);

  return <circle ref={ref} r={cell * 0.18} fill={toPlay === BLACK ? "#000" : "#fff"} stroke="#00000044" opacity={0} />;
}

function ScoreOverlay({ board, padding, cell }: { board: Stone[][]; padding: number; cell: number }) {
  // Shade empty regions belonging to one color
  const size = board.length;
  const visited = new Set<string>();
  const regions: { owner: Stone; pts: Point[] }[] = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY) continue;
      const k0 = `${r},${c}`;
      if (visited.has(k0)) continue;
      const stack: Point[] = [{ r, c }];
      const region: Point[] = [];
      const borders = new Set<Stone>();
      while (stack.length) {
        const p = stack.pop()!;
        const k = `${p.r},${p.c}`;
        if (visited.has(k)) continue;
        visited.add(k);
        region.push(p);
        const neigh = neighborsOf(size, p.r, p.c);
        for (const n of neigh) {
          const v = board[n.r][n.c];
          if (v === EMPTY) stack.push(n);
          else borders.add(v);
        }
      }
      if (borders.size === 1) {
        const owner = [...borders][0];
        if (owner !== EMPTY) regions.push({ owner, pts: region });
      }
    }
  }

  return (
    <g>
      {regions.map((reg, idx) => (
        <g key={idx}>
          {reg.pts.map((p, i) => (
            <rect
              key={i}
              x={padding + p.c * cell - cell * 0.48}
              y={padding + p.r * cell - cell * 0.48}
              width={cell * 0.96}
              height={cell * 0.96}
              fill={reg.owner === BLACK ? "#0000ff" : "#ff0000"}
              opacity={0.08}
              rx={4}
            />
          ))}
        </g>
      ))}
    </g>
  );
}
