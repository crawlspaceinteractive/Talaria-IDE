import { useEffect, useRef, useState } from "react";
import "@/App.css";
import { FroyoGame } from "@/froyo/game.js";

function App() {
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const [padConnected, setPadConnected] = useState(false);
  const [showHelp, setShowHelp] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const game = new FroyoGame(canvas);
    gameRef.current = game;
    game.start();

    // Poll pad connection status for the chrome badge
    const interval = setInterval(() => {
      setPadConnected(game.input.isGamepadConnected());
    }, 500);

    return () => {
      clearInterval(interval);
      game.stop();
      gameRef.current = null;
    };
  }, []);

  return (
    <div className="froyo-shell" data-testid="froyo-shell">
      <div className="froyo-bezel">
        <div className="froyo-bezel-top">
          <div className="froyo-led" data-testid="froyo-led-power" />
          <span className="froyo-bezel-title">FROYO ENGINE</span>
          <span className="froyo-bezel-version">v0.1 — SUNDAE ISLES</span>
          <span
            className={`froyo-pad-badge ${padConnected ? "on" : ""}`}
            data-testid="froyo-pad-badge"
          >
            {padConnected ? "GAMEPAD" : "KEYBOARD"}
          </span>
        </div>

        <div className="froyo-screen-wrap">
          <canvas
            ref={canvasRef}
            width={160}
            height={100}
            className="froyo-canvas"
            data-testid="froyo-canvas"
          />
          <div className="froyo-scanlines" aria-hidden="true" />
          <div className="froyo-glow" aria-hidden="true" />
        </div>

        <div className="froyo-bezel-bottom">
          <button
            type="button"
            className="froyo-help-toggle"
            data-testid="froyo-help-toggle"
            onClick={() => setShowHelp((v) => !v)}
          >
            {showHelp ? "HIDE CONTROLS" : "SHOW CONTROLS"}
          </button>
          <div className="froyo-bezel-corner">
            <span>160 × 100</span>
            <span>·</span>
            <span>SOFTWARE</span>
            <span>·</span>
            <span>15-BIT</span>
          </div>
        </div>
      </div>

      {showHelp && (
        <aside className="froyo-help-card" data-testid="froyo-help-card">
          <div className="froyo-help-row">
            <span className="k">W · S</span>
            <span className="v">MOVE FWD / BACK</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">A · D</span>
            <span className="v">TURN (PLAYER + CAM)</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">SPACE / A</span>
            <span className="v">JUMP · DOUBLE JUMP</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">SHIFT / LT</span>
            <span className="v">GLIDE (3RD JUMP · HOLD)</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">CTRL / RT</span>
            <span className="v">CHARGE (×2 GROUND SPEED)</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">R-STICK · DRAG</span>
            <span className="v">PITCH / ORBIT CAM</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">Q / E · LB / RB</span>
            <span className="v">FREE-CAM ORBIT</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">MOUSE DRAG</span>
            <span className="v">ORBIT + PITCH</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">J / X</span>
            <span className="v">ICE BREATH (FROM MUZZLE)</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">ENTER / START</span>
            <span className="v">PAUSE · CONFIRM</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">K / B</span>
            <span className="v">MENU CYCLE</span>
          </div>
          <div className="froyo-help-row">
            <span className="k">TAB / SELECT</span>
            <span className="v">DEBUG (HOLD)</span>
          </div>
          <p className="froyo-help-foot">
            Break crystals for sprinkles. Freeze dummies with ice breath. Find
            the pink portal to warp.
          </p>
        </aside>
      )}
    </div>
  );
}

export default App;
