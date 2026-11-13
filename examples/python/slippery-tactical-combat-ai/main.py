import asyncio
import collections
import dataclasses
import enum
import json
import math
import random
from collections import deque
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Callable, Optional

import esper
import js
import numpy as np
import pyodide
import scipy.ndimage
import scipy.optimize
import scipy.spatial.distance
from filterpy.kalman import KalmanFilter
from pydantic import BaseModel, ConfigDict, Field
from pyodide.ffi import create_proxy, to_js
from skimage.graph import MCP_Geometric
from transitions import Machine


def to_js_obj(d: dict[str, Any]) -> Any:
    """Convert a Python dictionary into a plain JavaScript Object."""
    return to_js(d, dict_converter=js.Object.fromEntries)


# region 0: BootstrapAndResourceInjection
async def bootstrap_and_resource_injection() -> dict[str, Any]:
    # Dynamically import lil-gui ES module
    lil_gui_mod = await js.eval('import("https://cdn.jsdelivr.net/npm/lil-gui@0.21/+esm")')
    GUI = lil_gui_mod.default

    document = js.document

    # Inject application stylesheet
    style = document.createElement("style")
    style.textContent = """
      :root {
        color-scheme: dark;
        --bg-base: oklch(0.10 0.01 240);
        --surface: oklch(0.06 0.005 240);
        --panel-bg: oklch(0.12 0.01 240 / 0.92);
        --text-main: oklch(0.92 0.01 240);
        --text-bright: oklch(0.99 0.005 240);
        --hero: oklch(0.86 0.22 195);
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        inline-size: 100%;
        block-size: 100dvh;
        overflow: clip;
        background: var(--bg-base);
        color: var(--text-main);
        user-select: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        -webkit-font-smoothing: antialiased;
      }
      #arena-container {
        position: relative;
        inline-size: 100%;
        block-size: 100%;
        background: var(--surface);
        display: grid;
        place-items: center;
        cursor: crosshair;
      }
      #combat-canvas { inline-size: 100%; block-size: 100%; display: block; }
      .toast-notification {
        position: absolute;
        inset-block-end: 1rem;
        inset-inline-start: 1rem;
        background: var(--panel-bg);
        border: 1px solid var(--hero);
        color: var(--text-bright);
        padding: 0.4rem 0.8rem;
        border-radius: 0.3rem;
        font-size: 0.7rem;
        z-index: 30;
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .toast-notification.visible { opacity: 1; transform: translateY(0); }
      .lil-gui {
        --background-color: oklch(0.12 0.01 240 / 0.92);
        --text-color: oklch(0.92 0.01 240);
        --title-background-color: oklch(0.16 0.01 240);
        --widget-color: oklch(0.20 0.01 240);
        --hover-color: oklch(0.26 0.01 240);
        --focus-color: oklch(0.86 0.22 195);
        --number-color: oklch(0.86 0.22 195);
        --string-color: oklch(0.82 0.26 90);
        --font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        backdrop-filter: blur(16px);
        border: 1px solid oklch(0.28 0.01 240 / 0.8);
        border-radius: 0.4rem;
      }
    """
    document.head.appendChild(style)

    # Inject DOM structure
    container = document.createElement("div")
    container.id = "arena-container"

    toast_el = document.createElement("div")
    toast_el.id = "toast-msg"
    toast_el.className = "toast-notification"
    toast_el.textContent = "Config updated"

    canvas = document.createElement("canvas")
    canvas.id = "combat-canvas"
    ctx = canvas.getContext("2d", to_js_obj({"alpha": False, "desynchronized": True}))

    container.append(toast_el, canvas)
    document.body.appendChild(container)

    return {
        "GUI": GUI,
        "container": container,
        "canvas": canvas,
        "ctx": ctx,
        "toast_el": toast_el,
    }
# endregion


# region 1: CoreMathAndTacticalAI
# region 1.1: EnumerationsAndConfigSchema
class TacticalState(StrEnum):
    ISOLATE_AND_ENGAGE = "ISOLATE_AND_ENGAGE"
    MULTI_COVER_RETREAT = "MULTI_COVER_RETREAT"
    KITE_AND_BAIT = "KITE_AND_BAIT"
    PEEK_AND_SHOOT = "PEEK_AND_SHOOT"
    AGGRESSIVE_PUSH = "AGGRESSIVE_PUSH"
    FLANK_STRIKE = "FLANK_STRIKE"
    ENFILADE_ESCAPE = "ENFILADE_ESCAPE"
    BREAKOUT = "BREAKOUT"


class AgentType(StrEnum):
    HERO = "HERO"
    ENEMY = "ENEMY"


class EnemyArchetype(StrEnum):
    STANDARD = "STANDARD"
    SCOUT = "SCOUT"
    HEAVY = "HEAVY"
    SNIPER = "SNIPER"


class WeaponType(StrEnum):
    SINGLE = "SINGLE"
    SHOTGUN = "SHOTGUN"
    BURST = "BURST"
    RAILGUN = "RAILGUN"


class ArenaLayout(StrEnum):
    DYNAMIC = "DYNAMIC"
    PILLARS = "PILLARS"
    BUNKERS = "BUNKERS"
    FORTRESS = "FORTRESS"
    OPEN = "OPEN"


class TargetPriorityMode(StrEnum):
    OPTIMAL_HYBRID = "OPTIMAL_HYBRID"
    LOWEST_HP = "LOWEST_HP"
    CLOSEST_PROXIMITY = "CLOSEST_PROXIMITY"
    HIGH_VALUE_FIRST = "HIGH_VALUE_FIRST"
    CLEAREST_LOS = "CLEAREST_LOS"


class LeadSolverMode(StrEnum):
    NEWTON_RAPHSON_CTRA = "NEWTON_RAPHSON_CTRA"
    QUADRATIC_CONSTANT_VELOCITY = "QUADRATIC_CONSTANT_VELOCITY"
    DIRECT_AIM_NO_LEAD = "DIRECT_AIM_NO_LEAD"


TAU: float = math.pi * 2.0
EPSILON: float = 1e-6


class SimulationConfig(BaseModel):
    """Pydantic schema-validated simulation configuration and parameter bounds."""
    model_config = ConfigDict(validate_assignment=True, extra="ignore")

    showPotentialField: bool = Field(default=False)
    showCostGrid: bool = Field(default=False)
    showEscapeAperture: bool = Field(default=False)
    showThreatVectors: bool = Field(default=False)
    showVelocityVectors: bool = Field(default=True)
    showTacticalAnchors: bool = Field(default=True)
    showDVOCandidates: bool = Field(default=False)
    showBallisticLead: bool = Field(default=True)
    showObstacleShadows: bool = Field(default=False)
    showTargetAnalysis: bool = Field(default=False)
    showEnclosureSectors: bool = Field(default=False)
    showPerimeterRings: bool = Field(default=False)
    showDiagnosticsHUD: bool = Field(default=True)
    targetPriorityMode: str = Field(default=TargetPriorityMode.OPTIMAL_HYBRID.value)
    leadSolverMode: str = Field(default=LeadSolverMode.NEWTON_RAPHSON_CTRA.value)
    dvoSampleCount: float = Field(default=360.0, ge=8.0, le=360.0)
    dvoTimeHorizon: float = Field(default=3.0, ge=0.1, le=32.0)
    dvoSafetyRadius: float = Field(default=8.0, ge=2.0, le=120.0)
    dvoEmergencyThreshold: float = Field(default=2.5, ge=0.02, le=5.0)
    macroNavigationWeight: float = Field(default=0.5, ge=0.1, le=4.0)
    localPotentialWeight: float = Field(default=0.5, ge=0.0, le=4.0)
    potentialFieldWeight: float = Field(default=8.0, ge=0.0, le=8.0)
    targetCommitDuration: float = Field(default=0.3, ge=0.0, le=5.0)
    kitingDistance: float = Field(default=120.0, ge=40.0, le=900.0)
    anchorSampleResolution: float = Field(default=120.0, ge=6.0, le=120.0)
    breakoutAggression: float = Field(default=1.0, ge=0.1, le=10.0)
    schmittMarginTarget: float = Field(default=140.0, ge=0.0, le=800.0)
    schmittMarginDistance: float = Field(default=55.0, ge=10.0, le=250.0)
    schmittMarginHealth: float = Field(default=0.16, ge=0.02, le=0.40)
    schmittMarginEnclosure: float = Field(default=0.18, ge=0.02, le=0.50)
    heroWeaponType: str = Field(default=WeaponType.SINGLE.value)
    heroSpeed: float = Field(default=250.0, ge=50.0, le=2000.0)
    heroFireRate: float = Field(default=6.0, ge=0.1, le=100.0)
    heroHealth: float = Field(default=100.0, ge=10.0, le=10000.0)
    heroRegenRate: float = Field(default=0.0, ge=0.0, le=500.0)
    heroBulletSpeed: float = Field(default=400.0, ge=100.0, le=5000.0)
    heroDamage: float = Field(default=5.0, ge=1.0, le=2000.0)
    dodgeForce: float = Field(default=500.0, ge=50.0, le=5000.0)
    bulletBounces: float = Field(default=0.0, ge=0.0, le=16.0)
    startWave: float = Field(default=1.0, ge=1.0, le=500.0)
    swarmMultiplier: float = Field(default=1.0, ge=0.1, le=10.0)
    enemySpeed: float = Field(default=250.0, ge=30.0, le=1500.0)
    enemyFireRate: float = Field(default=6.0, ge=0.05, le=50.0)
    enemyHealth: float = Field(default=100.0, ge=5.0, le=5000.0)
    enemyBulletSpeed: float = Field(default=400.0, ge=80.0, le=1000.0)
    enemyDamage: float = Field(default=5.0, ge=1.0, le=1000.0)
    arenaLayout: str = Field(default=ArenaLayout.FORTRESS.value)
    timeScale: float = Field(default=1.0, ge=0.01, le=10.0)


CONFIG_SCHEMA: dict[str, dict[str, Any]] = {
    "showPotentialField": {"type": "boolean", "default": False},
    "showCostGrid": {"type": "boolean", "default": False},
    "showEscapeAperture": {"type": "boolean", "default": False},
    "showThreatVectors": {"type": "boolean", "default": False},
    "showVelocityVectors": {"type": "boolean", "default": True},
    "showTacticalAnchors": {"type": "boolean", "default": True},
    "showDVOCandidates": {"type": "boolean", "default": False},
    "showBallisticLead": {"type": "boolean", "default": True},
    "showObstacleShadows": {"type": "boolean", "default": False},
    "showTargetAnalysis": {"type": "boolean", "default": False},
    "showEnclosureSectors": {"type": "boolean", "default": False},
    "showPerimeterRings": {"type": "boolean", "default": False},
    "showDiagnosticsHUD": {"type": "boolean", "default": True},
    "targetPriorityMode": {"type": "string", "default": TargetPriorityMode.OPTIMAL_HYBRID.value},
    "leadSolverMode": {"type": "string", "default": LeadSolverMode.NEWTON_RAPHSON_CTRA.value},
    "dvoSampleCount": {"type": "number", "default": 360, "min": 8, "max": 360},
    "dvoTimeHorizon": {"type": "number", "default": 3, "min": 0.1, "max": 32.0},
    "dvoSafetyRadius": {"type": "number", "default": 8, "min": 2, "max": 120},
    "dvoEmergencyThreshold": {"type": "number", "default": 2.5, "min": 0.02, "max": 5.0},
    "macroNavigationWeight": {"type": "number", "default": 0.5, "min": 0.1, "max": 4.0},
    "localPotentialWeight": {"type": "number", "default": 0.5, "min": 0, "max": 4.0},
    "potentialFieldWeight": {"type": "number", "default": 8, "min": 0, "max": 8.0},
    "targetCommitDuration": {"type": "number", "default": 0.3, "min": 0, "max": 5.0},
    "kitingDistance": {"type": "number", "default": 120, "min": 40, "max": 900},
    "anchorSampleResolution": {"type": "number", "default": 120, "min": 6, "max": 120},
    "breakoutAggression": {"type": "number", "default": 1.0, "min": 0.1, "max": 10.0},
    "schmittMarginTarget": {"type": "number", "default": 140, "min": 0, "max": 800},
    "schmittMarginDistance": {"type": "number", "default": 55, "min": 10, "max": 250},
    "schmittMarginHealth": {"type": "number", "default": 0.16, "min": 0.02, "max": 0.40},
    "schmittMarginEnclosure": {"type": "number", "default": 0.18, "min": 0.02, "max": 0.50},
    "heroWeaponType": {"type": "string", "default": WeaponType.SINGLE.value},
    "heroSpeed": {"type": "number", "default": 250, "min": 50, "max": 2000},
    "heroFireRate": {"type": "number", "default": 6, "min": 0.1, "max": 100},
    "heroHealth": {"type": "number", "default": 100, "min": 10, "max": 10000},
    "heroRegenRate": {"type": "number", "default": 0, "min": 0, "max": 500},
    "heroBulletSpeed": {"type": "number", "default": 400, "min": 100, "max": 5000},
    "heroDamage": {"type": "number", "default": 5, "min": 1, "max": 2000},
    "dodgeForce": {"type": "number", "default": 500, "min": 50, "max": 5000},
    "bulletBounces": {"type": "number", "default": 0, "min": 0, "max": 16},
    "startWave": {"type": "number", "default": 1, "min": 1, "max": 500},
    "swarmMultiplier": {"type": "number", "default": 1.0, "min": 0.1, "max": 10.0},
    "enemySpeed": {"type": "number", "default": 250, "min": 30, "max": 1500},
    "enemyFireRate": {"type": "number", "default": 6, "min": 0.05, "max": 50},
    "enemyHealth": {"type": "number", "default": 100, "min": 5, "max": 5000},
    "enemyBulletSpeed": {"type": "number", "default": 400, "min": 80, "max": 1000},
    "enemyDamage": {"type": "number", "default": 5, "min": 1, "max": 1000},
    "arenaLayout": {"type": "string", "default": ArenaLayout.FORTRESS.value},
    "timeScale": {"type": "number", "default": 1.0, "min": 0.01, "max": 10.0},
}


@dataclass(slots=True)
class Vec2:
    x: float = 0.0
    y: float = 0.0
    radius: float = 0.0

    def __getitem__(self, key: str) -> float:
        return getattr(self, key)

    def __setitem__(self, key: str, value: float) -> None:
        setattr(self, key, value)


@dataclass(slots=True)
class Obstacle:
    id: int
    x: float
    y: float
    radius: float


@dataclass(slots=True)
class AgentEntity:
    """ECS Component & Entity model for Hero and Hostile Agents."""
    id: str
    type: str
    x: float
    y: float
    vx: float = 0.0
    vy: float = 0.0
    targetVx: float = 0.0
    targetVy: float = 0.0
    angle: float = 0.0
    aimAngle: float = 0.0
    radius: float = 7.0
    maxSpeed: float = 250.0
    health: float = 100.0
    maxHealth: float = 100.0
    isAlive: bool = True
    fireCooldown: float = 0.0
    fireRate: float = 6.0
    bulletSpeed: float = 400.0
    damage: float = 5.0
    state: str = TacticalState.ISOLATE_AND_ENGAGE.value
    archetype: str = EnemyArchetype.STANDARD.value
    color: str = "oklch(0.86 0.22 195)"
    muzzleFlash: float = 0.0
    dodgeImpulse: Vec2 = field(default_factory=lambda: Vec2(0.0, 0.0))
    emergencyDodge: bool = False
    timeSinceHit: float = 99.0
    ecs_entity: int = -1


@dataclass(slots=True)
class ProjectileEntity:
    """ECS Component & Entity model for Ballistic Projectiles."""
    id: int
    shooterId: str
    shooterType: str
    x: float
    y: float
    vx: float
    vy: float
    radius: float
    damage: float
    bouncesRemaining: int
    isRailgun: bool
    hitAgents: set[str] = field(default_factory=set)
    trail: deque[Vec2] = field(default_factory=lambda: deque(maxlen=12))
    alive: bool = True
    distanceTraveled: float = 0.0
    maxDistance: float = 950.0
    color: str = "oklch(0.86 0.22 195)"
    ecs_entity: int = -1
# endregion


# region 1.2: ComputationalGeometryAndHysteresis
class Math2D:
    """2D vector calculus, Minkowski C-space collision, CCD ray-circle & TCPA/TTC solvers."""

    @staticmethod
    def dist_sq(a: Any, b: Any) -> float:
        return (a.x - b.x) ** 2 + (a.y - b.y) ** 2

    @staticmethod
    def dist(a: Any, b: Any) -> float:
        return math.hypot(a.x - b.x, a.y - b.y)

    @staticmethod
    def length(v: Any) -> float:
        return math.hypot(v.x, v.y)

    @staticmethod
    def length_sq(v: Any) -> float:
        return v.x ** 2 + v.y ** 2

    @staticmethod
    def normalize(v: Any) -> Vec2:
        l = math.hypot(v.x, v.y)
        return Vec2(0.0, 0.0) if l < EPSILON else Vec2(v.x / l, v.y / l)

    @staticmethod
    def dot(a: Any, b: Any) -> float:
        return a.x * b.x + a.y * b.y

    @staticmethod
    def cross(a: Any, b: Any) -> float:
        return a.x * b.y - a.y * b.x

    @staticmethod
    def add(a: Any, b: Any) -> Vec2:
        return Vec2(a.x + b.x, a.y + b.y)

    @staticmethod
    def sub(a: Any, b: Any) -> Vec2:
        return Vec2(a.x - b.x, a.y - b.y)

    @staticmethod
    def scale(v: Any, s: float) -> Vec2:
        return Vec2(v.x * s, v.y * s)

    @staticmethod
    def perp(v: Any, sign: float = 1.0) -> Vec2:
        return Vec2(-v.y * sign, v.x * sign)

    @staticmethod
    def specular_reflect(v: Any, n: Any) -> Vec2:
        d = 2.0 * Math2D.dot(v, n)
        return Vec2(v.x - d * n.x, v.y - d * n.y)

    @staticmethod
    def clamp(v: float, min_val: float, max_val: float) -> float:
        return max(min_val, min(max_val, v))

    @staticmethod
    def lerp(a: float, b: float, t: float) -> float:
        return a + (b - a) * t

    @staticmethod
    def geodesic_angle_difference(a: float, b: float) -> float:
        return ((((b - a) % TAU) + math.pi * 3.0) % TAU) - math.pi

    @staticmethod
    def lerp_angle(a: float, b: float, t: float) -> float:
        return a + Math2D.geodesic_angle_difference(a, b) * t

    @staticmethod
    def project_point_on_segment(p: Any, a: Any, b: Any) -> Vec2:
        ab_x = b.x - a.x
        ab_y = b.y - a.y
        len_sq = ab_x * ab_x + ab_y * ab_y
        if len_sq < EPSILON:
            return Vec2(a.x, a.y)
        t = Math2D.clamp(((p.x - a.x) * ab_x + (p.y - a.y) * ab_y) / len_sq, 0.0, 1.0)
        return Vec2(a.x + ab_x * t, a.y + ab_y * t)

    @staticmethod
    def distance_to_segment(p: Any, a: Any, b: Any) -> float:
        proj = Math2D.project_point_on_segment(p, a, b)
        return math.hypot(p.x - proj.x, p.y - proj.y)

    @staticmethod
    def has_line_of_sight(p1: Any, p2: Any, obstacles: list[Obstacle], pad: float = 4.0) -> bool:
        return not any(Math2D.distance_to_segment(o, p1, p2) <= o.radius + pad for o in obstacles)

    @staticmethod
    def test_minkowski_capsule_collision(
        p1: Any, p2: Any, obstacles: list[Obstacle], r: float = 3.5, m: float = 2.0
    ) -> bool:
        pad = r + m
        return not any(Math2D.distance_to_segment(o, p1, p2) <= o.radius + pad for o in obstacles)

    @staticmethod
    def raycast_circle_intersection(
        origin: Any, dir_vec: Any, center: Any, radius: float, max_dist: float
    ) -> Optional[dict[str, Any]]:
        d = Math2D.normalize(dir_vec)
        ox = origin.x - center.x
        oy = origin.y - center.y
        b = 2.0 * (d.x * ox + d.y * oy)
        c = ox * ox + oy * oy - radius * radius
        disc = b * b - 4.0 * c
        if disc < 0.0:
            return None
        s = math.sqrt(disc)
        t = (-b - s) * 0.5
        if t < 0.0:
            t = (-b + s) * 0.5
        if 0.0 <= t <= max_dist:
            pt = Vec2(origin.x + d.x * t, origin.y + d.y * t)
            return {
                "hit": True,
                "dist": t,
                "point": pt,
                "normal": Math2D.normalize(Math2D.sub(pt, center)),
            }
        return None

    @staticmethod
    def resolve_minimum_translation_vector(pos: Any, radius: float, obs: Obstacle) -> Vec2:
        dx = pos.x - obs.x
        dy = pos.y - obs.y
        dist_sq = dx * dx + dy * dy
        min_dist = radius + obs.radius
        if dist_sq >= min_dist * min_dist:
            return Vec2(pos.x, pos.y)
        if dist_sq > EPSILON:
            dist = math.sqrt(dist_sq)
            overlap = min_dist - dist
            return Vec2(pos.x + (dx / dist) * overlap, pos.y + (dy / dist) * overlap)
        return Vec2(pos.x + min_dist, pos.y)

    @staticmethod
    def compute_analytical_ttc(
        p_pos: Any, p_vel: Any, h_pos: Any, h_vel: Any, r_safe: float
    ) -> dict[str, Any]:
        rpx = h_pos.x - p_pos.x
        rpy = h_pos.y - p_pos.y
        rvx = h_vel.x - p_vel.x
        rvy = h_vel.y - p_vel.y
        a = rvx * rvx + rvy * rvy
        b = 2.0 * (rpx * rvx + rpy * rvy)
        c = rpx * rpx + rpy * rpy - r_safe * r_safe
        if c <= 0.0:
            if b >= 0.0:
                return {"willHit": False, "tEnter": math.inf, "tExit": 0.0, "minDist": math.hypot(rpx, rpy)}
            return {"willHit": True, "tEnter": 0.0, "tExit": 0.2, "minDist": 0.0}
        if a < EPSILON:
            return {"willHit": False, "tEnter": math.inf, "tExit": math.inf, "minDist": math.hypot(rpx, rpy)}
        disc = b * b - 4.0 * a * c
        t_min = max(0.0, -b / (2.0 * a))
        min_dist = math.sqrt(max(0.0, a * (t_min ** 2) + b * t_min + rpx * rpx + rpy * rpy))
        if disc < 0.0:
            return {"willHit": False, "tEnter": math.inf, "tExit": math.inf, "minDist": min_dist}
        s = math.sqrt(disc)
        t_enter = (-b - s) / (2.0 * a)
        t_exit = (-b + s) / (2.0 * a)
        return {
            "willHit": t_exit > 0.0 and t_enter >= -0.05,
            "tEnter": max(0.0, t_enter),
            "tExit": t_exit,
            "minDist": min_dist,
        }

    @staticmethod
    def is_swept_ray_blocked(
        origin: Any, vel: Any, obstacles: list[Obstacle], max_time: float, pad: float = 3.0
    ) -> bool:
        spd = math.hypot(vel.x, vel.y)
        if spd < EPSILON or max_time <= 0.0:
            return False
        dir_vec = Vec2(vel.x / spd, vel.y / spd)
        max_dist = spd * max_time
        return any(
            Math2D.raycast_circle_intersection(origin, dir_vec, o, o.radius + pad, max_dist) is not None
            for o in obstacles
        )

    @staticmethod
    def is_in_geometric_umbra(pt: Any, threat: Any, obs: Obstacle, margin: float = 3.0) -> bool:
        orad = obs.radius + margin
        d_obs = Math2D.dist(obs, threat)
        return (
            d_obs > orad
            and Math2D.dist(pt, threat) > d_obs
            and Math2D.distance_to_segment(obs, threat, pt) <= orad
        )


class SchmittTrigger:
    """Dual-threshold bistable comparator & competitive margin hysteresis (Schmitt, 1938)."""

    @staticmethod
    def evaluate(val: float, state: bool, low: float, high: float) -> bool:
        return val > low if state else val >= high

    @staticmethod
    def evaluate_inverted(val: float, state: bool, low: float, high: float) -> bool:
        return val < high if state else val <= low

    @staticmethod
    def has_margin_advantage(cand: float, inc: float, margin: float) -> bool:
        return cand > inc + margin
# endregion


# region 1.3: KinematicObserver
@dataclass
class TargetKinematicsRecord:
    pos: Vec2
    vel: Vec2
    acc: Vec2
    prev_vel: Vec2
    kf: KalmanFilter
    pos_history: deque[Vec2] = field(default_factory=lambda: deque(maxlen=20))
    velocity_history: deque[Vec2] = field(default_factory=lambda: deque(maxlen=15))
    movement_pattern_score: float = 0.75
    avg_speed: float = 0.0
    dir_change_rate: float = 0.0
    angular_rate: float = 0.0


class TacticalKinematicObserver:
    """Filtered kinematic state observer using FilterPy Kalman Filter + EMA smoothing."""
    _history: dict[str, TargetKinematicsRecord] = {}

    @classmethod
    def reset(cls) -> None:
        cls._history.clear()

    @classmethod
    def _create_kalman_filter(cls, pos: Vec2, vel: Vec2) -> KalmanFilter:
        kf = KalmanFilter(dim_x=6, dim_z=4)
        kf.x = np.array([[pos.x], [pos.y], [vel.x], [vel.y], [0.0], [0.0]], dtype=float)
        kf.H = np.array(
            [
                [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
                [0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            ],
            dtype=float,
        )
        kf.P *= 10.0
        kf.R = np.diag([2.0, 2.0, 6.0, 6.0])
        kf.Q = np.eye(6, dtype=float) * 0.8
        return kf

    @classmethod
    def update_target_kinematics(cls, enemies: list[AgentEntity], dt: float) -> None:
        safe_dt = max(dt, 0.001)
        F_mat = np.array(
            [
                [1.0, 0.0, safe_dt, 0.0, 0.5 * safe_dt * safe_dt, 0.0],
                [0.0, 1.0, 0.0, safe_dt, 0.0, 0.5 * safe_dt * safe_dt],
                [0.0, 0.0, 1.0, 0.0, safe_dt, 0.0],
                [0.0, 0.0, 0.0, 1.0, 0.0, safe_dt],
                [0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            ],
            dtype=float,
        )

        for e in enemies:
            if not e.isAlive:
                cls._history.pop(e.id, None)
                continue
            cur_pos = Vec2(e.x, e.y)
            cur_vel = Vec2(e.vx, e.vy)
            prev = cls._history.get(e.id)
            if prev is None:
                kf = cls._create_kalman_filter(cur_pos, cur_vel)
                rec = TargetKinematicsRecord(
                    pos=cur_pos,
                    vel=cur_vel,
                    acc=Vec2(0.0, 0.0),
                    prev_vel=cur_vel,
                    kf=kf,
                    avg_speed=math.hypot(cur_vel.x, cur_vel.y),
                )
                rec.pos_history.append(cur_pos)
                rec.velocity_history.append(cur_vel)
                cls._history[e.id] = rec
            else:
                prev.kf.F = F_mat
                prev.kf.predict()
                z = np.array([[cur_pos.x], [cur_pos.y], [cur_vel.x], [cur_vel.y]], dtype=float)
                prev.kf.update(z)
                kf_state = prev.kf.x.ravel()

                # Blend Kalman filter acceleration with finite-difference EMA filter
                fd_ax = (cur_vel.x - prev.vel.x) / safe_dt
                fd_ay = (cur_vel.y - prev.vel.y) / safe_dt
                blended_ax = 0.65 * fd_ax + 0.35 * float(kf_state[4])
                blended_ay = 0.65 * fd_ay + 0.35 * float(kf_state[5])
                prev.acc = Vec2(
                    Math2D.lerp(prev.acc.x, blended_ax, 0.5),
                    Math2D.lerp(prev.acc.y, blended_ay, 0.5),
                )

                raw_omega = (
                    Math2D.geodesic_angle_difference(
                        math.atan2(prev.vel.y, prev.vel.x),
                        math.atan2(cur_vel.y, cur_vel.x),
                    )
                    / safe_dt
                )
                prev.angular_rate = Math2D.lerp(prev.angular_rate, raw_omega, 0.4)
                prev.prev_vel = prev.vel
                prev.vel = cur_vel
                prev.pos = cur_pos
                prev.pos_history.append(cur_pos)
                prev.velocity_history.append(cur_vel)
                prev.avg_speed = Math2D.lerp(prev.avg_speed, math.hypot(cur_vel.x, cur_vel.y), 0.15)

                if len(prev.velocity_history) >= 4:
                    changes = 0
                    vel_list = list(prev.velocity_history)
                    for k in range(1, len(vel_list)):
                        v_a = vel_list[k - 1]
                        v_b = vel_list[k]
                        m_a = math.hypot(v_a.x, v_a.y)
                        m_b = math.hypot(v_b.x, v_b.y)
                        if m_a > 5.0 and m_b > 5.0 and (v_a.x * v_b.x + v_a.y * v_b.y) / (m_a * m_b) < 0.85:
                            changes += 1
                    prev.dir_change_rate = Math2D.lerp(
                        prev.dir_change_rate, changes / len(vel_list), 0.2
                    )
                    prev.movement_pattern_score = Math2D.lerp(
                        prev.movement_pattern_score, 1.0 - prev.dir_change_rate, 0.15
                    )

    @classmethod
    def get_estimated_kinematics(cls, enemy_id: str) -> Optional[TargetKinematicsRecord]:
        return cls._history.get(enemy_id)
# endregion


# region 1.4: PotentialFieldAndGeodesicNav
class KhatibArtificialPotentialFieldEngine:
    """Hybrid NF1 Geodesic Distance Transform (scikit-image MCP_Geometric) + Local APF Engine (NumPy)."""
    _cell_size: int = 32
    _cols: int = 0
    _rows: int = 0
    _distance_field: Optional[np.ndarray] = None
    _obstacle_mask: Optional[np.ndarray] = None
    _macro_grad_x: Optional[np.ndarray] = None
    _macro_grad_y: Optional[np.ndarray] = None
    _local_grid: Optional[np.ndarray] = None
    _unified_grid: Optional[np.ndarray] = None
    _grad_x: Optional[np.ndarray] = None
    _grad_y: Optional[np.ndarray] = None
    _px_grid: Optional[np.ndarray] = None
    _py_grid: Optional[np.ndarray] = None

    @classmethod
    def build(
        cls,
        hero: AgentEntity,
        enemies: list[AgentEntity],
        projectiles: list[ProjectileEntity],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        preferred_anchor: Optional[Vec2] = None,
        config: Optional[dict[str, Any]] = None,
    ) -> None:
        cols = math.ceil(arena_w / cls._cell_size)
        rows = math.ceil(arena_h / cls._cell_size)
        if cls._px_grid is None or cls._cols != cols or cls._rows != rows:
            cls._cols = cols
            cls._rows = rows
            rx = (np.arange(cols, dtype=np.float32) + 0.5) * cls._cell_size
            ry = (np.arange(rows, dtype=np.float32) + 0.5) * cls._cell_size
            cls._px_grid, cls._py_grid = np.meshgrid(rx, ry)

        px = cls._px_grid
        py = cls._py_grid
        alive = [e for e in enemies if e.isAlive]
        cx = arena_w * 0.5
        cy = arena_h * 0.5
        h_rad = hero.radius if hero.radius else 14.0
        obs_margin = h_rad + 6.0
        wall_margin = padding + h_rad + 4.0

        # Step 1: Vectorized C-Space obstacle & wall discretization
        obs_mask = (
            (px < wall_margin)
            | (px > arena_w - wall_margin)
            | (py < wall_margin)
            | (py > arena_h - wall_margin)
        )
        for o in obstacles:
            obs_mask |= ((px - o.x) ** 2 + (py - o.y) ** 2) <= (o.radius + obs_margin) ** 2
        cls._obstacle_mask = obs_mask

        # Compute distance to nearest alive enemy for each grid cell
        if alive:
            ex = np.array([e.x for e in alive], dtype=np.float32)[:, None, None]
            ey = np.array([e.y for e in alive], dtype=np.float32)[:, None, None]
            e_dists = np.hypot(px[None, :, :] - ex, py[None, :, :] - ey)
            min_e_dist = np.min(e_dists, axis=0)
        else:
            e_dists = None
            min_e_dist = np.full((rows, cols), 600.0, dtype=np.float32)

        # Step 2: Topological macro-egress goal sink planting
        wall_clearance = np.minimum(
            np.minimum(px - padding, arena_w - padding - px),
            np.minimum(py - padding, arena_h - padding - py),
        )
        sink_score = (
            min_e_dist * 1.5
            + wall_clearance * 0.85
            - np.hypot(px - cx, py - cy) * 0.25
        )
        if preferred_anchor is not None:
            d_a = np.hypot(px - preferred_anchor.x, py - preferred_anchor.y)
            sink_score += np.where(d_a < 90.0, (90.0 - d_a) * 8.0, 0.0)

        interior_free = ~obs_mask.copy()
        interior_free[0, :] = False
        interior_free[-1, :] = False
        interior_free[:, 0] = False
        interior_free[:, -1] = False

        sink_mask = interior_free & (min_e_dist > 340.0) & (wall_clearance > 120.0)
        starts = np.argwhere(sink_mask)
        if len(starts) == 0:
            if np.any(interior_free):
                masked_scores = np.where(interior_free, sink_score, -np.inf)
                best_ry, best_rx = np.unravel_index(int(np.argmax(masked_scores)), (rows, cols))
            else:
                best_ry, best_rx = rows // 2, cols // 2
                obs_mask[best_ry, best_rx] = False
            starts = np.array([[best_ry, best_rx]], dtype=int)

        # Step 3: 8-connected NF1 geodesic wavefront propagation via scikit-image MCP_Geometric
        friction = np.zeros((rows, cols), dtype=np.float32)
        if e_dists is not None:
            near_mask = e_dists < 160.0
            friction = np.sum(np.where(near_mask, ((160.0 - e_dists) / 160.0) * 1.8, 0.0), axis=0)

        cost_grid = np.where(obs_mask, -1.0, 1.0 + friction).astype(np.float64)
        for s_ry, s_rx in starts:
            cost_grid[s_ry, s_rx] = 1.0

        mcp = MCP_Geometric(cost_grid)
        dist_field, _ = mcp.find_costs(starts)
        dist_field = np.where(np.isinf(dist_field), 1e9, dist_field).astype(np.float32)
        for s_ry, s_rx in starts:
            dist_field[s_ry, s_rx] = 0.0
        cls._distance_field = dist_field

        # Step 4 & 5: Macro gradient (-∇D) & local micro-hazard APF
        gy, gx = np.gradient(dist_field, float(cls._cell_size))
        g_len = np.hypot(gx, gy)
        valid_g = (~obs_mask) & (g_len > EPSILON)
        cls._macro_grad_x = np.where(valid_g, -gx / np.maximum(g_len, EPSILON), 0.0).astype(np.float32)
        cls._macro_grad_y = np.where(valid_g, -gy / np.maximum(g_len, EPSILON), 0.0).astype(np.float32)

        pot = np.zeros((rows, cols), dtype=np.float32)
        for o in obstacles:
            d_o = np.hypot(px - o.x, py - o.y)
            pot += np.where(
                d_o < o.radius + 12.0,
                2000.0,
                np.where(
                    d_o < o.radius + 36.0,
                    (((o.radius + 36.0 - d_o) / 36.0) ** 2) * 320.0,
                    0.0,
                ),
            )

        for p in projectiles:
            if not p.alive or p.shooterType == AgentType.HERO.value:
                continue
            spd = math.hypot(p.vx, p.vy)
            if spd < 10.0:
                continue
            tx = p.vx / spd
            ty = p.vy / spd
            dmg = p.damage if p.damage else 16.0
            dx = px - p.x
            dy = py - p.y
            lon = dx * tx + dy * ty
            lat = np.abs(-dx * ty + dy * tx)
            corridor_mask = (lon > 0.0) & (lon < 420.0) & (lat < 48.0)
            pot += np.where(
                corridor_mask,
                ((48.0 - lat) / 48.0) * ((420.0 - lon) / 420.0) * 1100.0 * (dmg / 16.0),
                0.0,
            )

        if e_dists is not None:
            d_sq = e_dists ** 2
            pot += np.sum(np.where(d_sq < 48400.0, 32000.0 / (d_sq + 2400.0), 0.0), axis=0)

        cls._local_grid = pot

        # Step 6: Unified gradient synthesis
        w_macro = float(config.get("macroNavigationWeight", 0.65)) if config else 0.65
        w_local = float(config.get("localPotentialWeight", 0.45)) if config else 0.45
        l_gy, l_gx = np.gradient(pot, float(cls._cell_size))
        cls._grad_x = -(cls._macro_grad_x * w_macro - l_gx * w_local).astype(np.float32)
        cls._grad_y = -(cls._macro_grad_y * w_macro - l_gy * w_local).astype(np.float32)
        cls._unified_grid = (np.minimum(1200.0, dist_field) * 1.5 + pot).astype(np.float32)

    @classmethod
    def _bilerp(cls, arr: Optional[np.ndarray], x: float, y: float) -> float:
        if arr is None:
            return 0.0
        fx = Math2D.clamp(x / cls._cell_size - 0.5, 0.0, cls._cols - 1.0)
        fy = Math2D.clamp(y / cls._cell_size - 0.5, 0.0, cls._rows - 1.0)
        x0 = int(fx)
        y0 = int(fy)
        x1 = min(cls._cols - 1, x0 + 1)
        y1 = min(cls._rows - 1, y0 + 1)
        tx = fx - x0
        ty = fy - y0
        top = float(arr[y0, x0]) + (float(arr[y0, x1]) - float(arr[y0, x0])) * tx
        bot = float(arr[y1, x0]) + (float(arr[y1, x1]) - float(arr[y1, x0])) * tx
        return top + (bot - top) * ty

    @classmethod
    def sample_potential_bilinear(cls, x: float, y: float) -> float:
        return cls._bilerp(cls._unified_grid, x, y)

    @classmethod
    def sample_gradient_bilinear(cls, x: float, y: float) -> Vec2:
        return Vec2(cls._bilerp(cls._grad_x, x, y), cls._bilerp(cls._grad_y, x, y))

    @classmethod
    def sample_macro_navigation_vector(cls, x: float, y: float) -> Vec2:
        return Math2D.normalize(
            Vec2(cls._bilerp(cls._macro_grad_x, x, y), cls._bilerp(cls._macro_grad_y, x, y))
        )

    @classmethod
    def get_grid_data(cls) -> dict[str, Any]:
        return {
            "grid": cls._unified_grid,
            "cols": cls._cols,
            "rows": cls._rows,
            "cellSize": cls._cell_size,
        }
# endregion


# region 1.5: ApertureAndBallisticSolvers
class AngularSweepApertureSolver:
    """1D circular interval sweep-line enclosure & volume ray-marched breakout solver."""

    @staticmethod
    def evaluate_aperture_and_pinch(
        hero: AgentEntity,
        alive_enemies: list[AgentEntity],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
    ) -> dict[str, Any]:
        h_pos = Vec2(hero.x, hero.y)
        h_vel = Vec2(hero.vx, hero.vy)
        to_center = Math2D.normalize(Vec2(arena_w * 0.5 - h_pos.x, arena_h * 0.5 - h_pos.y))
        min_wall_x = min(h_pos.x - padding, arena_w - padding - h_pos.x)
        min_wall_y = min(h_pos.y - padding, arena_h - padding - h_pos.y)
        min_wall_dist = min(min_wall_x, min_wall_y)
        is_near_corner = (min_wall_x < 260.0 and min_wall_y < 260.0) or min_wall_dist < 140.0
        is_deep_corner = (min_wall_x < 150.0 and min_wall_y < 150.0) or min_wall_dist < 75.0

        converging_hostile_count = 0
        enemy_angles: list[float] = []
        for e in alive_enemies:
            to_h = Math2D.sub(h_pos, e)
            dist = math.hypot(to_h.x, to_h.y)
            if dist < 0.1:
                continue
            closing = Math2D.dot(
                Vec2((e.vx or 0.0) - h_vel.x, (e.vy or 0.0) - h_vel.y),
                Vec2(to_h.x / dist, to_h.y / dist),
            )
            pred_dist = math.hypot(
                h_pos.x + h_vel.x * 2.0 - (e.x + (e.vx or 0.0) * 2.0),
                h_pos.y + h_vel.y * 2.0 - (e.y + (e.vy or 0.0) * 2.0),
            )
            if dist < 480.0 or pred_dist < 360.0 or closing > 20.0:
                converging_hostile_count += 1
                enemy_angles.append(math.atan2(e.y - h_pos.y, e.x - h_pos.x))

        angular_enclosure = 0.0
        pinch_wedges: list[dict[str, float]] = []
        if len(enemy_angles) >= 2:
            enemy_angles.sort()
            max_gap = 0.0
            n_ang = len(enemy_angles)
            for i in range(n_ang):
                nxt = (i + 1) % n_ang
                gap = enemy_angles[nxt] - enemy_angles[i]
                if gap < 0.0:
                    gap += TAU
                pinch_wedges.append({"start": enemy_angles[i], "end": enemy_angles[nxt], "gap": gap})
                if gap > max_gap:
                    max_gap = gap
            angular_enclosure = TAU - max_gap

        best_aperture_dir = to_center
        best_aperture_angle = math.atan2(to_center.y, to_center.x)
        max_score = -math.inf

        for i in range(64):
            ang = (i * TAU) / 64.0
            dir_vec = Vec2(math.cos(ang), math.sin(ang))
            clear_dist = 320.0
            pot_sum = 0.0
            for step in (60.0, 120.0, 180.0, 240.0, 300.0):
                pt = Vec2(h_pos.x + dir_vec.x * step, h_pos.y + dir_vec.y * step)
                if (
                    pt.x < padding + 25.0
                    or pt.x > arena_w - padding - 25.0
                    or pt.y < padding + 25.0
                    or pt.y > arena_h - padding - 25.0
                ):
                    clear_dist = step
                    pot_sum += 800.0
                    break
                if any(Math2D.dist(pt, o) < o.radius + 18.0 for o in obstacles):
                    clear_dist = step
                    pot_sum += 1200.0
                    break
                pot_sum += KhatibArtificialPotentialFieldEngine.sample_potential_bilinear(pt.x, pt.y)

            score = (clear_dist / 320.0) * 600.0 + Math2D.dot(dir_vec, to_center) * 300.0 - pot_sum * 0.4
            if score > max_score:
                max_score = score
                best_aperture_dir = dir_vec
                best_aperture_angle = ang

        return {
            "isEnclosureTrap": (
                (angular_enclosure > math.pi * 0.95 and converging_hostile_count >= 3)
                or (angular_enclosure > math.pi * 0.75 and is_near_corner and converging_hostile_count >= 2)
            ),
            "isCornerPinch": is_near_corner and converging_hostile_count >= 2,
            "isSeverePinch": is_deep_corner and converging_hostile_count >= 1,
            "angularEnclosure": angular_enclosure,
            "pinchWedges": pinch_wedges,
            "convergingHostileCount": converging_hostile_count,
            "bestApertureDir": best_aperture_dir,
            "bestApertureAngle": best_aperture_angle,
            "minWallDist": min_wall_dist,
        }

    @staticmethod
    def find_corridor_blaster_target(
        hero_pos: Vec2, escape_dir: Vec2, alive_enemies: list[AgentEntity]
    ) -> Optional[AgentEntity]:
        best: Optional[AgentEntity] = None
        min_score = math.inf
        for e in alive_enemies:
            to_e = Math2D.sub(e, hero_pos)
            dist = math.hypot(to_e.x, to_e.y)
            if dist < 0.1:
                continue
            align = Math2D.dot(Vec2(to_e.x / dist, to_e.y / dist), escape_dir)
            if align > 0.15 and dist < 520.0:
                score = e.health * 1.5 + dist * 0.35 - align * 180.0
                if score < min_score:
                    min_score = score
                    best = e
        return best


class KinematicBallisticInterceptSolver:
    """Nonlinear CTRA Newton-Raphson ballistic intercept root-finder using scipy.optimize.newton."""

    @staticmethod
    def solve(
        origin: Any,
        target_pos: Any,
        target_vel: Any,
        target_acc: Any,
        target_angular_rate: float,
        bullet_speed: float,
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        barrel_offset: float = 18.0,
        predictability: float = 0.85,
        solver_mode: str = LeadSolverMode.NEWTON_RAPHSON_CTRA.value,
    ) -> dict[str, Any]:
        if solver_mode == LeadSolverMode.DIRECT_AIM_NO_LEAD.value:
            to_d = Math2D.normalize(Math2D.sub(target_pos, origin))
            barrel_origin = Vec2(origin.x + to_d.x * barrel_offset, origin.y + to_d.y * barrel_offset)
            t_pos = Vec2(target_pos.x, target_pos.y)
            return {
                "pos": t_pos,
                "time": Math2D.dist(origin, target_pos) / bullet_speed,
                "hasClearPath": Math2D.test_minkowski_capsule_collision(
                    barrel_origin, t_pos, obstacles, 3.5, 1.5
                ),
                "barrelOrigin": barrel_origin,
                "projectedArc": [t_pos],
            }

        dx = target_pos.x - origin.x
        dy = target_pos.y - origin.y
        vx = target_vel.x
        vy = target_vel.y
        use_acc = solver_mode == LeadSolverMode.NEWTON_RAPHSON_CTRA.value
        acc_scale = 0.5 * Math2D.clamp(predictability, 0.1, 1.0) if use_acc else 0.0
        ax = (target_acc.x if target_acc else 0.0) * acc_scale
        ay = (target_acc.y if target_acc else 0.0) * acc_scale

        # Step 1: Closed-form quadratic constant-velocity seed
        a_q = vx * vx + vy * vy - bullet_speed * bullet_speed
        b_q = 2.0 * (dx * vx + dy * vy)
        c_q = dx * dx + dy * dy
        t_est = 0.2
        if abs(a_q) > EPSILON:
            disc = b_q * b_q - 4.0 * a_q * c_q
            if disc >= 0.0:
                s_q = math.sqrt(disc)
                t1 = (-b_q - s_q) / (2.0 * a_q)
                t2 = (-b_q + s_q) / (2.0 * a_q)
                if t1 > 0.01 and t2 > 0.01:
                    t_est = min(t1, t2)
                elif t1 > 0.01:
                    t_est = t1
                elif t2 > 0.01:
                    t_est = t2
        t_est = Math2D.clamp(t_est, 0.01, 2.0)

        # Step 2: Newton-Raphson iterations over CTRA motion equations
        omega = Math2D.clamp(target_angular_rate or 0.0, -4.0, 4.0) * predictability if use_acc else 0.0
        cur_spd = math.hypot(vx, vy)
        h0 = math.atan2(vy, vx)
        has_turn = abs(omega) > 0.15 and cur_spd > 10.0
        min_x = padding + 16.0
        max_x = arena_w - padding - 16.0
        min_y = padding + 16.0
        max_y = arena_h - padding - 16.0

        def eval_pos(t: float, blend: float = 1.0) -> tuple[float, float, float, float]:
            if has_turn:
                h = h0 + omega * t * blend
                px = target_pos.x + (math.sin(h) - math.sin(h0)) * (cur_spd / omega) + ax * (t ** 2) * blend
                py = target_pos.y - (math.cos(h) - math.cos(h0)) * (cur_spd / omega) + ay * (t ** 2) * blend
                pvx = math.cos(h) * cur_spd + 2.0 * ax * t
                pvy = math.sin(h) * cur_spd + 2.0 * ay * t
                return px, py, pvx, pvy
            px = target_pos.x + (vx * t + ax * (t ** 2)) * blend
            py = target_pos.y + (vy * t + ay * (t ** 2)) * blend
            pvx = vx + 2.0 * ax * t
            pvy = vy + 2.0 * ay * t
            return px, py, pvx, pvy

        if use_acc:
            def f_obj(t: float) -> float:
                px, py, _, _ = eval_pos(t)
                px = Math2D.clamp(px, min_x, max_x)
                py = Math2D.clamp(py, min_y, max_y)
                cur_dist = math.hypot(px - origin.x, py - origin.y)
                return max(1.0, cur_dist - barrel_offset) - bullet_speed * t

            def f_prime(t: float) -> float:
                px, py, pvx, pvy = eval_pos(t)
                if px <= min_x:
                    px = min_x
                    pvx = max(0.0, pvx)
                elif px >= max_x:
                    px = max_x
                    pvx = min(0.0, pvx)
                if py <= min_y:
                    py = min_y
                    pvy = max(0.0, pvy)
                elif py >= max_y:
                    py = max_y
                    pvy = min(0.0, pvy)
                rx = px - origin.x
                ry = py - origin.y
                cur_dist = math.hypot(rx, ry)
                if cur_dist < EPSILON:
                    return -bullet_speed
                return (rx * pvx + ry * pvy) / cur_dist - bullet_speed

            try:
                root = float(scipy.optimize.newton(f_obj, t_est, fprime=f_prime, tol=1e-4, maxiter=8))
                if 0.005 < root <= 2.5:
                    t_est = root
            except (RuntimeError, ValueError, ZeroDivisionError):
                pass

        t_est = Math2D.clamp(t_est, 0.01, 2.2)
        blend = Math2D.clamp(0.6 + predictability * 0.4, 0.6, 1.0)
        raw_px, raw_py, _, _ = eval_pos(t_est, blend)
        pred_pos = Vec2(Math2D.clamp(raw_px, min_x, max_x), Math2D.clamp(raw_py, min_y, max_y))
        to_pred = Math2D.normalize(Math2D.sub(pred_pos, origin))
        barrel_origin = Vec2(origin.x + to_pred.x * barrel_offset, origin.y + to_pred.y * barrel_offset)
        has_clear_path = Math2D.test_minkowski_capsule_collision(
            barrel_origin, pred_pos, obstacles, 3.5, 1.5
        ) or (
            cur_spd < 15.0
            and Math2D.test_minkowski_capsule_collision(origin, target_pos, obstacles, 3.5, 1.5)
        )

        projected_arc: list[Vec2] = []
        for s in range(7):
            arc_x, arc_y, _, _ = eval_pos((t_est * s) / 6.0, blend)
            projected_arc.append(Vec2(arc_x, arc_y))

        return {
            "pos": pred_pos,
            "time": t_est,
            "hasClearPath": has_clear_path,
            "barrelOrigin": barrel_origin,
            "projectedArc": projected_arc,
        }
# endregion


# region 1.6: DVOAndCoverSelection
@dataclass(slots=True)
class DVOCandidate:
    vel: Vec2
    penalty: float
    speed: float
    dir: Vec2


class DynamicVelocityObstacleOptimizer:
    """Dynamic Velocity Obstacles (DVO) & Dynamic Window (DWA) velocity-space planner (Vectorized NumPy)."""

    @staticmethod
    def evaluate_threats(
        hero: AgentEntity,
        projectiles: list[ProjectileEntity],
        obstacles: list[Obstacle],
        safety_margin: float = 16.0,
        time_horizon: float = 1.6,
    ) -> list[dict[str, Any]]:
        h_pos = Vec2(hero.x, hero.y)
        h_vel = Vec2(hero.vx, hero.vy)
        r_safe = hero.radius + safety_margin
        threats: list[dict[str, Any]] = []

        for proj in projectiles:
            if not proj.alive or proj.shooterType == AgentType.HERO.value:
                continue
            p_pos = Vec2(proj.x, proj.y)
            p_vel = Vec2(proj.vx, proj.vy)
            p_spd = math.hypot(p_vel.x, p_vel.y)
            if p_spd < EPSILON:
                continue
            p_dir = Vec2(p_vel.x / p_spd, p_vel.y / p_spd)
            to_h = Math2D.sub(h_pos, p_pos)
            dist = math.hypot(to_h.x, to_h.y)
            closing = Math2D.dot(to_h, p_dir)
            if closing <= -15.0 and dist > r_safe + 30.0:
                continue

            ttc_still = Math2D.compute_analytical_ttc(p_pos, p_vel, h_pos, Vec2(0.0, 0.0), r_safe)
            ttc_mov = Math2D.compute_analytical_ttc(p_pos, p_vel, h_pos, h_vel, r_safe)
            min_t_enter = min(
                ttc_still["tEnter"] if ttc_still["willHit"] else 99.0,
                ttc_mov["tEnter"] if ttc_mov["willHit"] else 99.0,
            )
            if Math2D.is_swept_ray_blocked(p_pos, p_vel, obstacles, min(min_t_enter, time_horizon), 3.5):
                continue

            is_imminent = (ttc_still["willHit"] and ttc_still["tEnter"] < time_horizon) or (
                ttc_mov["willHit"] and ttc_mov["tEnter"] < time_horizon
            )
            is_soft = not is_imminent and closing > 0.0 and dist < 650.0 and ttc_still["minDist"] < r_safe + 55.0
            if is_imminent or is_soft:
                t_hit = min_t_enter if min_t_enter < 90.0 else math.inf
                urgency = (
                    20.0 / (min(t_hit, 1.4) + 0.02)
                    if is_imminent
                    else 2.5 / (ttc_still["minDist"] + 10.0)
                )
                threats.append(
                    {
                        "proj": proj,
                        "pPos": p_pos,
                        "pVel": p_vel,
                        "pDir": p_dir,
                        "pSpeed": p_spd,
                        "distToHero": dist,
                        "tCpa": t_hit if t_hit < 90.0 else ttc_still["tEnter"],
                        "distCpa": min(ttc_still["minDist"], ttc_mov["minDist"]),
                        "isImminent": is_imminent,
                        "urgency": urgency,
                    }
                )

        threats.sort(key=lambda t: (-t["urgency"], t["tCpa"]))
        return threats

    @staticmethod
    def solve_optimal_velocity(
        hero: AgentEntity,
        desired_dir: Vec2,
        desired_spd: float,
        threats: list[dict[str, Any]],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        samples: int = 48,
        is_breakout: bool = False,
        safety_margin: float = 16.0,
        time_horizon: float = 1.6,
        record_candidates: bool = False,
    ) -> dict[str, Any]:
        h_pos_x = hero.x
        h_pos_y = hero.y
        cur_vx = hero.vx
        cur_vy = hero.vy
        r_safe = hero.radius + safety_margin

        speeds = (
            np.array([desired_spd * 1.1, desired_spd, desired_spd * 0.85], dtype=np.float32)
            if is_breakout
            else np.array(
                [
                    desired_spd,
                    desired_spd * 0.8,
                    desired_spd * 1.15,
                    desired_spd * 0.5,
                    desired_spd * 0.25,
                    0.0,
                ],
                dtype=np.float32,
            )
        )

        count = max(16, int(samples))
        angles = np.linspace(0.0, TAU, count, endpoint=False, dtype=np.float32)
        dir_list_x = [desired_dir.x] + list(np.cos(angles))
        dir_list_y = [desired_dir.y] + list(np.sin(angles))
        for th in threats[:4]:
            p_dir = th["pDir"]
            dir_list_x.extend([-p_dir.y, p_dir.y])
            dir_list_y.extend([p_dir.x, -p_dir.x])

        dirs_x = np.array(dir_list_x, dtype=np.float32)[:, None]
        dirs_y = np.array(dir_list_y, dtype=np.float32)[:, None]
        cand_vx = (dirs_x * speeds[None, :]).ravel()
        cand_vy = (dirs_y * speeds[None, :]).ravel()
        cand_spd = np.broadcast_to(speeds[None, :], ( len(dir_list_x), len(speeds) )).ravel()
        cand_dir_x = np.broadcast_to(dirs_x, (len(dir_list_x), len(speeds))).ravel()
        cand_dir_y = np.broadcast_to(dirs_y, (len(dir_list_x), len(speeds))).ravel()

        n_cand = len(cand_vx)
        penalties = np.zeros(n_cand, dtype=np.float32)

        # Vectorized projectile TTC evaluation across all velocity candidates
        for th in threats:
            p_pos = th["pPos"]
            p_vel = th["pVel"]
            urgency = float(th["urgency"])
            rpx = h_pos_x - p_pos.x
            rpy = h_pos_y - p_pos.y
            rvx = cand_vx - p_vel.x
            rvy = cand_vy - p_vel.y
            a = rvx * rvx + rvy * rvy
            b = 2.0 * (rpx * rvx + rpy * rvy)
            c = rpx * rpx + rpy * rpy - r_safe * r_safe

            if c <= 0.0:
                will_hit = b < 0.0
                t_enter = np.zeros(n_cand, dtype=np.float32)
                min_dist = np.where(will_hit, 0.0, math.hypot(rpx, rpy))
            else:
                safe_a = np.maximum(a, EPSILON)
                disc = b * b - 4.0 * safe_a * c
                t_min = np.maximum(0.0, -b / (2.0 * safe_a))
                min_dist = np.sqrt(np.maximum(0.0, safe_a * (t_min ** 2) + b * t_min + rpx * rpx + rpy * rpy))
                valid_disc = disc >= 0.0
                s = np.sqrt(np.maximum(0.0, disc))
                raw_t_enter = (-b - s) / (2.0 * safe_a)
                raw_t_exit = (-b + s) / (2.0 * safe_a)
                will_hit = valid_disc & (raw_t_exit > 0.0) & (raw_t_enter >= -0.05)
                t_enter = np.maximum(0.0, raw_t_enter)

            hit_mask = will_hit & (t_enter < time_horizon)
            if np.any(hit_mask):
                mult = np.where(t_enter < 0.25, 4.0, np.where(t_enter < 0.6, 2.0, 1.0))
                base_hit_pen = (1.0 / (t_enter + 0.02)) * 95000.0 * urgency * mult
                penalties += np.where(hit_mask, base_hit_pen, 0.0)

            near_mask = (~hit_mask) & (min_dist < r_safe + 28.0)
            penalties += np.where(near_mask, (r_safe + 28.0 - min_dist) * 600.0, 0.0)

        # Vectorized 3-step spatial lookahead for walls, corners, and obstacles
        wall_m = padding + 32.0
        corner_m = padding + 140.0
        lookaheads = (0.12, 0.28, 0.48)
        for l_idx, lh in enumerate(lookaheads):
            tw = 1.0 / (l_idx + 1.0)
            fx = h_pos_x + cand_vx * lh
            fy = h_pos_y + cand_vy * lh
            wall_hit = (fx < wall_m) | (fx > arena_w - wall_m) | (fy < wall_m) | (fy > arena_h - wall_m)
            corner_hit = ((fx < corner_m) | (fx > arena_w - corner_m)) & (
                (fy < corner_m) | (fy > arena_h - corner_m)
            )
            penalties += np.where(wall_hit, 45000.0 * tw, 0.0)
            penalties += np.where(corner_hit, 35000.0 * tw, 0.0)
            for o in obstacles:
                d_o = np.hypot(fx - o.x, fy - o.y)
                min_a = o.radius + hero.radius + 8.0
                obs_hit = d_o < min_a
                penalties += np.where(obs_hit, (min_a - d_o) * 2000.0 + 25000.0, 0.0)

        desired_vx = desired_dir.x * desired_spd
        desired_vy = desired_dir.y * desired_spd
        dev_weight = 2.2 if is_breakout else (0.4 if threats else 1.2)
        penalties += (
            np.hypot(cand_vx - desired_vx, cand_vy - desired_vy) * dev_weight
            + np.hypot(cand_vx - cur_vx, cand_vy - cur_vy) * 0.15
        )

        best_idx = int(np.argmin(penalties))
        best_vel = Vec2(float(cand_vx[best_idx]), float(cand_vy[best_idx]))
        min_penalty = float(penalties[best_idx])

        evaluated_candidates: list[DVOCandidate] = []
        if record_candidates:
            step = max(1, n_cand // 180)
            for idx in range(0, n_cand, step):
                evaluated_candidates.append(
                    DVOCandidate(
                        vel=Vec2(float(cand_vx[idx]), float(cand_vy[idx])),
                        penalty=float(penalties[idx]),
                        speed=float(cand_spd[idx]),
                        dir=Vec2(float(cand_dir_x[idx]), float(cand_dir_y[idx])),
                    )
                )

        return {
            "bestVel": best_vel,
            "penalty": min_penalty,
            "evaluatedCandidates": evaluated_candidates,
        }

    @staticmethod
    def compute_orthogonal_missile_evasion_impulse(
        imminent_threats: list[dict[str, Any]], macro_escape_dir: Vec2, dodge_force: float
    ) -> Vec2:
        if not imminent_threats:
            return Vec2(0.0, 0.0)
        jx = 0.0
        jy = 0.0
        w_sum = 0.0
        for th in imminent_threats[:3]:
            w = th["urgency"] * (3.0 if th["tCpa"] < 0.2 else 1.5)
            s_a = Math2D.perp(th["pDir"], 1.0)
            s_b = Math2D.perp(th["pDir"], -1.0)
            chosen = s_a if Math2D.dot(s_a, macro_escape_dir) >= Math2D.dot(s_b, macro_escape_dir) else s_b
            jx += chosen.x * w
            jy += chosen.y * w
            w_sum += w
        if w_sum < EPSILON:
            return Vec2(0.0, 0.0)
        return Math2D.scale(Math2D.normalize(Vec2(jx, jy)), dodge_force * 0.85)


class TacticalPositionSelectionArchitecture:
    """Analytical bitangent shadow-frustum cover node evaluator (Straatman et al., 2005; Crow, 1977)."""

    @staticmethod
    def find_tactical_anchor(
        hero_pos: Vec2,
        primary_target: Optional[AgentEntity],
        all_enemies: list[AgentEntity],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        sample_res: int = 20,
        ideal_standoff: float = 240.0,
    ) -> Vec2:
        if primary_target is None:
            return hero_pos
        min_x = padding + 36.0
        max_x = arena_w - padding - 36.0
        min_y = padding + 36.0
        max_y = arena_h - padding - 36.0
        alive = [e for e in all_enemies if e.isAlive]
        sec_enemies = [e for e in alive if e.id != primary_target.id]
        h_rad = hero_pos.radius if hero_pos.radius else 14.0
        t_pos = Vec2(primary_target.x, primary_target.y)
        best_anchor: Optional[Vec2] = None
        max_score = -math.inf

        for i, obs in enumerate(obstacles):
            dist_tc = Math2D.dist(obs, t_pos)
            dilated_r = obs.radius + h_rad
            if dist_tc <= dilated_r + EPSILON:
                continue
            base_ang = math.atan2(obs.y - t_pos.y, obs.x - t_pos.x)
            theta_off = math.asin(Math2D.clamp(dilated_r / dist_tc, -1.0, 1.0))
            tan_dist = math.sqrt(max(0.0, dist_tc * dist_tc - dilated_r * dilated_r)) + 18.0

            for sign in (-1.0, 1.0):
                ang = base_ang + sign * theta_off
                cand = Vec2(t_pos.x + math.cos(ang) * tan_dist, t_pos.y + math.sin(ang) * tan_dist)
                if cand.x < min_x or cand.x > max_x or cand.y < min_y or cand.y > max_y:
                    continue
                if any(k != i and Math2D.dist(cand, o) < o.radius + 20.0 for k, o in enumerate(obstacles)):
                    continue

                occluded = 0
                for sec in sec_enemies:
                    if Math2D.is_in_geometric_umbra(cand, sec, obs, 2.0) or not Math2D.has_line_of_sight(
                        cand, sec, obstacles, 5.0
                    ):
                        occluded += 1

                has_los = Math2D.has_line_of_sight(cand, t_pos, obstacles, 4.5)
                d_target = Math2D.dist(cand, t_pos)
                if has_los:
                    los_bonus = (
                        800.0
                        - abs(d_target - ideal_standoff) * 2.2
                        + (300.0 if ideal_standoff * 0.7 <= d_target <= ideal_standoff * 1.35 else 0.0)
                    )
                else:
                    los_bonus = 150.0 - abs(d_target - ideal_standoff * 0.8) * 0.8

                score = (
                    occluded * 1400.0
                    + los_bonus
                    - Math2D.dist(hero_pos, cand) * 0.45
                    - KhatibArtificialPotentialFieldEngine.sample_potential_bilinear(cand.x, cand.y) * 1.5
                )
                if score > max_score:
                    max_score = score
                    best_anchor = cand

        return best_anchor if best_anchor is not None else hero_pos
# endregion


# region 1.7: TacticalAndSwarmControllers
class TacticalCombatFSM:
    """Autonomous Combat Finite State Machine powered by the `transitions` library."""
    state: str

    def __init__(self) -> None:
        states = [s.value for s in TacticalState]
        self.machine = Machine(
            model=self,
            states=states,
            initial=TacticalState.ISOLATE_AND_ENGAGE.value,
            auto_transitions=True,
        )
        self._trigger_map = {
            TacticalState.ISOLATE_AND_ENGAGE.value: "to_ISOLATE_AND_ENGAGE",
            TacticalState.MULTI_COVER_RETREAT.value: "to_MULTI_COVER_RETREAT",
            TacticalState.KITE_AND_BAIT.value: "to_KITE_AND_BAIT",
            TacticalState.PEEK_AND_SHOOT.value: "to_PEEK_AND_SHOOT",
            TacticalState.AGGRESSIVE_PUSH.value: "to_AGGRESSIVE_PUSH",
            TacticalState.FLANK_STRIKE.value: "to_FLANK_STRIKE",
            TacticalState.ENFILADE_ESCAPE.value: "to_ENFILADE_ESCAPE",
            TacticalState.BREAKOUT.value: "to_BREAKOUT",
        }

    def transition_to(self, target_state: str) -> None:
        if self.state != target_state and target_state in self._trigger_map:
            getattr(self, self._trigger_map[target_state])()

    def reset(self) -> None:
        self.to_ISOLATE_AND_ENGAGE()


class TacticalDecisionController:
    """Layered Context Steering, MAUT Target Prioritization & Schmitt-Trigger FSM Controller."""
    _last_target_id: Optional[str] = None
    _target_commit_timer: float = 0.0
    _preferred_anchor: Optional[Vec2] = None
    _anchor_age: float = 0.0
    _dash_cooldown: float = 0.0
    _strafe_sign: float = 1.0
    _strafe_timer: float = 0.0
    _juke_timer: float = 0.0
    _juke_offset: float = 0.0
    _state_commit_timer: float = 0.0
    _fsm: TacticalCombatFSM = TacticalCombatFSM()
    _breakout_timer: float = 0.0
    _breakout_dir: Optional[Vec2] = None
    _breakout_target_id: Optional[str] = None
    _last_health: float = 140.0
    _damage_taken_timer: float = 0.0
    _blended_macro_dir: Vec2 = Vec2(0.0, 0.0)
    _smoothed_weights: dict[str, float] = {"hp": 0.0, "pinch": 0.0, "push": 0.0, "hazard": 0.0}
    _in_emergency_dodge: bool = False

    @classmethod
    def reset(cls) -> None:
        cls._last_target_id = None
        cls._target_commit_timer = 0.0
        cls._preferred_anchor = None
        cls._anchor_age = 0.0
        cls._dash_cooldown = 0.0
        cls._strafe_sign = 1.0
        cls._strafe_timer = 0.0
        cls._juke_timer = 0.0
        cls._juke_offset = 0.0
        cls._state_commit_timer = 0.0
        cls._fsm.reset()
        cls._breakout_timer = 0.0
        cls._breakout_dir = None
        cls._breakout_target_id = None
        cls._last_health = 140.0
        cls._damage_taken_timer = 0.0
        cls._blended_macro_dir = Vec2(0.0, 0.0)
        cls._smoothed_weights = {"hp": 0.0, "pinch": 0.0, "push": 0.0, "hazard": 0.0}
        cls._in_emergency_dodge = False

    @classmethod
    def evaluate(
        cls,
        hero: AgentEntity,
        enemies: list[AgentEntity],
        projectiles: list[ProjectileEntity],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        config: dict[str, Any],
        dt: float = 1.0 / 60.0,
    ) -> dict[str, Any]:
        step_dt = Math2D.clamp(dt or 1.0 / 60.0, 1.0 / 120.0, 0.033)
        cls._dash_cooldown = max(0.0, cls._dash_cooldown - step_dt)
        cls._target_commit_timer = max(0.0, cls._target_commit_timer - step_dt)
        cls._state_commit_timer = max(0.0, cls._state_commit_timer - step_dt)
        cls._damage_taken_timer = max(0.0, cls._damage_taken_timer - step_dt)
        cls._breakout_timer = max(0.0, cls._breakout_timer - step_dt)

        alive = [e for e in enemies if e.isAlive]
        TacticalKinematicObserver.update_target_kinematics(alive, step_dt)
        KhatibArtificialPotentialFieldEngine.build(
            hero, alive, projectiles, obstacles, arena_w, arena_h, padding, cls._preferred_anchor, config
        )

        if not alive:
            cls.reset()
            return {
                "targetVelocity": Vec2(0.0, 0.0),
                "aimAngle": hero.aimAngle,
                "shouldFire": False,
                "state": TacticalState.ISOLATE_AND_ENGAGE.value,
                "targetEnemyId": None,
                "dodgeImpulse": Vec2(0.0, 0.0),
                "emergencyDodge": False,
                "apertureData": None,
                "anchorPos": None,
                "dvoDebugCandidates": [],
                "ballisticSolution": None,
                "targetScoreTable": [],
            }

        hero_pos = Vec2(hero.x, hero.y, hero.radius)
        bullet_speed = float(config.get("heroBulletSpeed", 640.0))
        hero_speed = float(hero.maxSpeed or config.get("heroSpeed", 320.0))
        hero_damage = float(config.get("heroDamage", 36.0))
        dvo_samples = int(config.get("dvoSampleCount", 48))
        dvo_horizon = float(config.get("dvoTimeHorizon", 1.6))
        dvo_safety = float(config.get("dvoSafetyRadius", 16.0))
        emergency_threshold = float(config.get("dvoEmergencyThreshold", 0.28))
        potential_bias = float(config.get("potentialFieldWeight", 0.55))
        lead_solver_mode = str(config.get("leadSolverMode", LeadSolverMode.NEWTON_RAPHSON_CTRA.value))
        kiting_standoff = float(config.get("kitingDistance", 240.0))
        schmitt_margin_target = float(config.get("schmittMarginTarget", 140.0))
        schmitt_margin_distance = float(config.get("schmittMarginDistance", 55.0))
        schmitt_margin_health = float(config.get("schmittMarginHealth", 0.16))

        hp_ratio = hero.health / max(1.0, hero.maxHealth)
        if hero.health < cls._last_health:
            cls._damage_taken_timer = 0.9
        cls._last_health = hero.health

        aperture_data = AngularSweepApertureSolver.evaluate_aperture_and_pinch(
            hero, alive, obstacles, arena_w, arena_h, padding
        )
        if (
            aperture_data["isSeverePinch"]
            or aperture_data["isCornerPinch"]
            or aperture_data["isEnclosureTrap"]
        ) and cls._breakout_timer <= 0.0:
            cls._breakout_timer = (1.0 + random.random() * 0.4) * float(config.get("breakoutAggression", 1.2))
            cls._breakout_dir = aperture_data["bestApertureDir"]
            corridor_target = AngularSweepApertureSolver.find_corridor_blaster_target(
                hero_pos, cls._breakout_dir, alive
            )
            cls._breakout_target_id = corridor_target.id if corridor_target else None

        in_breakout = cls._breakout_timer > 0.0
        primary_target: Optional[AgentEntity] = None
        if in_breakout and cls._breakout_target_id:
            primary_target = next((e for e in alive if e.id == cls._breakout_target_id), None)
        if primary_target is not None:
            cls._last_target_id = primary_target.id

        # MAUT target evaluation & Lanchester attrition commitment (Keeney & Raiffa, 1976)
        scored_enemies: list[dict[str, Any]] = []
        for enemy in alive:
            dist = Math2D.dist(hero_pos, enemy)
            has_clear = Math2D.test_minkowski_capsule_collision(hero_pos, enemy, obstacles, 3.5, 1.5)
            hp = enemy.health
            kin = TacticalKinematicObserver.get_estimated_kinematics(enemy.id)
            shots = math.ceil(hp / max(1.0, hero_damage))
            max_hp = enemy.maxHealth or 100.0
            score = (
                (950.0 if shots <= 1 else 550.0 if shots <= 2 else 280.0 if shots <= 3 else 0.0)
                + ((max_hp - hp) / max_hp) * 500.0
            )
            score += (500.0 + (150.0 if hero.fireCooldown <= 0.05 else 0.0)) if has_clear else -300.0
            score += (180.0 - dist) * 1.8 if dist < 180.0 else ((380.0 - dist) * 0.8 if dist < 380.0 else 0.0)
            if kin and kin.movement_pattern_score > 0.6:
                score += 80.0
            if enemy.archetype == EnemyArchetype.SNIPER.value:
                score += 180.0
            if enemy.archetype == EnemyArchetype.SCOUT.value and dist < 260.0:
                score += 220.0
            scored_enemies.append({"enemy": enemy, "score": score})

        scored_enemies.sort(key=lambda item: item["score"], reverse=True)

        if primary_target is None and scored_enemies:
            top = scored_enemies[0]
            inc = next((i for i in scored_enemies if i["enemy"].id == cls._last_target_id), None)
            if inc is not None and inc["enemy"].isAlive:
                bonus = (max(0.0, (inc["enemy"].maxHealth or 100.0) - inc["enemy"].health) / max(1.0, hero_damage)) * 45.0
                margin = schmitt_margin_target * 1.8 if cls._target_commit_timer > 0.0 else schmitt_margin_target
                adv = SchmittTrigger.has_margin_advantage(top["score"], inc["score"] + bonus, margin)
                melee = Math2D.dist(hero_pos, top["enemy"]) < 85.0 and top["score"] > inc["score"]
                if (top["enemy"].id != inc["enemy"].id and adv) or melee:
                    primary_target = top["enemy"]
                    cls._last_target_id = top["enemy"].id
                    cls._target_commit_timer = float(config.get("targetCommitDuration", 0.55))
                else:
                    primary_target = inc["enemy"]
            else:
                primary_target = top["enemy"]
                cls._last_target_id = top["enemy"].id
                cls._target_commit_timer = float(config.get("targetCommitDuration", 0.55))

        assert primary_target is not None

        threats = DynamicVelocityObstacleOptimizer.evaluate_threats(
            hero, projectiles, obstacles, dvo_safety, dvo_horizon
        )
        imminent = [t for t in threats if t["isImminent"]]
        min_ttc = min((t["tCpa"] for t in imminent), default=math.inf)
        cls._in_emergency_dodge = SchmittTrigger.evaluate_inverted(
            min_ttc, cls._in_emergency_dodge, emergency_threshold, emergency_threshold * 1.45
        )
        is_emergency = cls._in_emergency_dodge

        t_dist = Math2D.dist(hero_pos, primary_target)
        target_has_los = Math2D.test_minkowski_capsule_collision(
            hero_pos, primary_target, obstacles, 3.5, 1.5
        )

        cls._anchor_age += step_dt
        if cls._anchor_age > 0.12 or cls._preferred_anchor is None:
            cls._preferred_anchor = TacticalPositionSelectionArchitecture.find_tactical_anchor(
                hero_pos,
                primary_target,
                alive,
                obstacles,
                arena_w,
                arena_h,
                padding,
                int(config.get("anchorSampleResolution", 20)),
                kiting_standoff,
            )
            cls._anchor_age = 0.0
        anchor_pos = cls._preferred_anchor

        macro_escape_dir = KhatibArtificialPotentialFieldEngine.sample_macro_navigation_vector(
            hero_pos.x, hero_pos.y
        )
        grad = KhatibArtificialPotentialFieldEngine.sample_gradient_bilinear(hero_pos.x, hero_pos.y)
        grad_force = Math2D.normalize(Vec2(-grad.x, -grad.y))
        to_target = Math2D.normalize(Math2D.sub(primary_target, hero_pos))
        center_dir = Math2D.normalize(Vec2(arena_w * 0.5 - hero_pos.x, arena_h * 0.5 - hero_pos.y))

        cls._strafe_timer -= step_dt
        if cls._strafe_timer <= 0.0:
            cls._strafe_timer = 0.18 + random.random() * 0.22
            if random.random() >= 0.35:
                cls._strafe_sign *= -1.0

        cls._juke_timer -= step_dt
        if cls._juke_timer <= 0.0:
            cls._juke_timer = 0.08 + random.random() * 0.12
            cls._juke_offset = (random.random() - 0.5) * 0.4

        # Layered context steering vectors (cover, aperture, kite, push, hazard)
        v_cover = Math2D.normalize(
            Math2D.add(
                Math2D.scale(Math2D.normalize(Math2D.sub(anchor_pos, hero_pos)), 0.58),
                Math2D.scale(macro_escape_dir, 0.42),
            )
        )
        esc_dir = cls._breakout_dir if cls._breakout_dir is not None else aperture_data["bestApertureDir"]
        v_aperture = Math2D.normalize(
            Math2D.add(
                Math2D.add(Math2D.scale(esc_dir, 0.52), Math2D.scale(macro_escape_dir, 0.36)),
                Math2D.scale(center_dir, 0.12),
            )
        )
        radial = Math2D.scale(to_target, Math2D.clamp((t_dist - kiting_standoff) / 85.0, -1.0, 1.0))
        strafe = Math2D.scale(Math2D.perp(to_target, cls._strafe_sign + cls._juke_offset), 0.82)
        v_kite = Math2D.normalize(Math2D.add(Math2D.add(radial, strafe), Math2D.scale(macro_escape_dir, 0.28)))
        v_push = Math2D.normalize(
            Math2D.add(
                Math2D.scale(to_target, 0.85),
                Math2D.scale(Math2D.perp(to_target, cls._strafe_sign), 0.42),
            )
        )

        s_swarm = Math2D.clamp((len(alive) - 1.0) / 5.0, 0.0, 1.0)
        s_ballistic = Math2D.clamp((len(threats) + len(imminent) * 0.5) / 3.0, 0.0, 1.0)
        exposed_count = sum(
            1
            for e in alive
            if Math2D.test_minkowski_capsule_collision(hero_pos, e, obstacles, 3.5, 1.5)
        )
        s_exposure = Math2D.clamp((exposed_count - 2.0) / 2.0, 0.0, 1.0)
        s_enclosure = Math2D.clamp(
            (aperture_data["angularEnclosure"] - math.pi * 0.35) / (math.pi * 0.45), 0.0, 1.0
        )
        w_reactive = Math2D.clamp((0.70 - hp_ratio) / 0.45, 0.0, 1.0) + (
            (cls._damage_taken_timer / 0.9) * 0.45 if cls._damage_taken_timer > 0.0 else 0.0
        )
        w_proactive = max(s_swarm * s_exposure, s_ballistic, s_enclosure * 0.85)
        if len(alive) == 1 and target_has_los and hp_ratio > 0.50:
            w_proactive = 0.0

        target_w_hp = Math2D.clamp(max(w_reactive, w_proactive), 0.0, 1.0)
        target_w_pinch = Math2D.clamp(
            max(
                Math2D.clamp((aperture_data["angularEnclosure"] - math.pi * 0.45) / (math.pi * 0.45), 0.0, 1.0)
                * 0.85,
                Math2D.clamp((190.0 - aperture_data["minWallDist"]) / 140.0, 0.0, 1.0) * 0.65,
            )
            + (max(0.65, cls._breakout_timer) if in_breakout else 0.0),
            0.0,
            1.0,
        )
        target_w_push = (
            Math2D.clamp((hp_ratio - 0.45) / 0.35, 0.0, 1.0)
            * Math2D.clamp((420.0 - t_dist) / 260.0, 0.0, 1.0)
            if len(alive) == 1 and target_has_los
            else 0.0
        )
        target_w_hazard = Math2D.clamp(potential_bias + len(imminent) * 0.25, 0.15, 0.85)

        w_rate = 1.0 - ((1.0 - 0.28) ** (step_dt * 60.0))
        cls._smoothed_weights["hp"] = Math2D.lerp(cls._smoothed_weights["hp"], target_w_hp, w_rate)
        cls._smoothed_weights["pinch"] = Math2D.lerp(cls._smoothed_weights["pinch"], target_w_pinch, w_rate)
        cls._smoothed_weights["push"] = Math2D.lerp(cls._smoothed_weights["push"], target_w_push, w_rate)
        cls._smoothed_weights["hazard"] = Math2D.lerp(cls._smoothed_weights["hazard"], target_w_hazard, w_rate)

        w_hp = cls._smoothed_weights["hp"]
        w_pinch = cls._smoothed_weights["pinch"]
        w_push = cls._smoothed_weights["push"]
        w_hazard = cls._smoothed_weights["hazard"]

        combat_auth = max(0.05, 1.0 - min(1.0, w_hp + w_pinch))
        v_combat = Math2D.normalize(Math2D.add(Math2D.scale(v_push, w_push), Math2D.scale(v_kite, 1.0 - w_push)))
        raw_blended = Math2D.add(
            Math2D.add(Math2D.scale(v_cover, w_hp), Math2D.scale(v_aperture, w_pinch)),
            Math2D.add(Math2D.scale(v_combat, combat_auth), Math2D.scale(grad_force, w_hazard)),
        )
        norm_raw = Math2D.normalize(raw_blended) if Math2D.length(raw_blended) > EPSILON else macro_escape_dir
        v_rate = 1.0 - ((1.0 - 0.38) ** (step_dt * 60.0))
        cls._blended_macro_dir.x = Math2D.lerp(cls._blended_macro_dir.x, norm_raw.x, v_rate)
        cls._blended_macro_dir.y = Math2D.lerp(cls._blended_macro_dir.y, norm_raw.y, v_rate)
        desired_macro_dir = (
            Math2D.normalize(cls._blended_macro_dir)
            if Math2D.length(cls._blended_macro_dir) > EPSILON
            else norm_raw
        )

        if (
            aperture_data["minWallDist"] > 140.0 + schmitt_margin_distance * 0.9
            and not aperture_data["isCornerPinch"]
            and cls._breakout_timer < 0.6
        ):
            cls._breakout_timer = 0.0

        current_state = cls._fsm.state
        retreat_thresh = (
            0.70 - schmitt_margin_health * 0.5
            if current_state == TacticalState.MULTI_COVER_RETREAT.value
            else 0.70
        )
        cover_thresh = (
            0.48 - schmitt_margin_health * 0.5
            if current_state in (TacticalState.MULTI_COVER_RETREAT.value, TacticalState.PEEK_AND_SHOOT.value)
            else 0.48
        )
        can_peek = target_has_los and Math2D.dist(hero_pos, anchor_pos) < 100.0 and cls._damage_taken_timer <= 0.0

        dom_state = TacticalState.ISOLATE_AND_ENGAGE.value
        if w_pinch > 0.62 or in_breakout:
            dom_state = TacticalState.BREAKOUT.value
        elif w_pinch > 0.42 and aperture_data["angularEnclosure"] > math.pi * 0.65:
            dom_state = TacticalState.ENFILADE_ESCAPE.value
        elif w_hp > retreat_thresh or (cls._damage_taken_timer > 0.0 and hp_ratio < 0.38):
            dom_state = TacticalState.MULTI_COVER_RETREAT.value
        elif w_hp > cover_thresh:
            dom_state = TacticalState.PEEK_AND_SHOOT.value if can_peek else TacticalState.MULTI_COVER_RETREAT.value
        elif w_push > 0.52:
            dom_state = TacticalState.AGGRESSIVE_PUSH.value
        elif t_dist < kiting_standoff * 1.15:
            dom_state = TacticalState.KITE_AND_BAIT.value

        if cls._fsm.state != dom_state and (cls._state_commit_timer <= 0.0 or in_breakout or is_emergency):
            cls._fsm.transition_to(dom_state)
            cls._state_commit_timer = 0.20

        effective_speed = hero_speed * (1.0 + 0.18 * w_pinch + (0.12 if is_emergency else 0.0))
        dvo_res = DynamicVelocityObstacleOptimizer.solve_optimal_velocity(
            hero,
            desired_macro_dir,
            effective_speed,
            threats,
            obstacles,
            arena_w,
            arena_h,
            padding,
            dvo_samples,
            in_breakout,
            dvo_safety,
            dvo_horizon,
            bool(config.get("showDVOCandidates", False)),
        )
        best_vel = dvo_res["bestVel"]
        evaluated_candidates = dvo_res["evaluatedCandidates"]

        dodge_impulse = Vec2(0.0, 0.0)
        dodge_mag = float(config.get("dodgeForce", 680.0))
        if in_breakout and cls._dash_cooldown <= 0.0:
            dodge_impulse = Math2D.scale(macro_escape_dir, dodge_mag * 0.45)
            cls._dash_cooldown = 0.22
        elif is_emergency and cls._dash_cooldown <= 0.0:
            dodge_impulse = DynamicVelocityObstacleOptimizer.compute_orthogonal_missile_evasion_impulse(
                imminent, desired_macro_dir, dodge_mag
            )
            cls._dash_cooldown = 0.20

        kin = TacticalKinematicObserver.get_estimated_kinematics(primary_target.id)
        ballistic_solution = KinematicBallisticInterceptSolver.solve(
            hero_pos,
            primary_target,
            kin.vel if kin else Vec2(primary_target.vx or 0.0, primary_target.vy or 0.0),
            kin.acc if kin else Vec2(0.0, 0.0),
            kin.angular_rate if kin else 0.0,
            bullet_speed,
            obstacles,
            arena_w,
            arena_h,
            padding,
            hero.radius + 6.0,
            kin.movement_pattern_score if kin else 0.85,
            lead_solver_mode,
        )

        aim_dir = Math2D.normalize(Math2D.sub(ballistic_solution["pos"], hero_pos))
        target_aim_angle = math.atan2(aim_dir.y, aim_dir.x)
        ang_err = abs(Math2D.geodesic_angle_difference(hero.aimAngle, target_aim_angle))
        lerp_t = 0.65 if ang_err > 1.0 else (0.52 if ang_err > 0.3 else 0.44)
        predicted_aim_angle = Math2D.lerp_angle(hero.aimAngle, target_aim_angle, lerp_t)
        align = Math2D.dot(Vec2(math.cos(predicted_aim_angle), math.sin(predicted_aim_angle)), aim_dir)
        fire_thresh = (
            0.82
            if in_breakout
            else (0.88 if cls._fsm.state == TacticalState.AGGRESSIVE_PUSH.value else 0.93)
        )

        return {
            "targetVelocity": best_vel,
            "aimAngle": predicted_aim_angle,
            "shouldFire": ballistic_solution["hasClearPath"] and align > fire_thresh and hero.fireCooldown <= 0.0,
            "state": cls._fsm.state,
            "targetEnemyId": primary_target.id,
            "dodgeImpulse": dodge_impulse,
            "emergencyDodge": is_emergency or in_breakout,
            "apertureData": aperture_data,
            "anchorPos": anchor_pos,
            "dvoDebugCandidates": evaluated_candidates,
            "ballisticSolution": ballistic_solution,
            "targetScoreTable": scored_enemies,
        }


class EnemyAIController:
    """Hostile swarm AI: Reynolds separation flocking (Reynolds, 1987) + Braitenberg whisker feelers."""

    @staticmethod
    def update_enemy(
        enemy: AgentEntity,
        hero: AgentEntity,
        all_enemies: list[AgentEntity],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        idx: int,
    ) -> dict[str, Any]:
        if not enemy.isAlive or not hero.isAlive:
            return {"targetVelocity": Vec2(0.0, 0.0), "aimAngle": enemy.aimAngle, "shouldFire": False}

        e_pos = Vec2(enemy.x, enemy.y)
        h_pos = Vec2(hero.x, hero.y)
        dist = Math2D.dist(e_pos, h_pos)
        h_dir = Math2D.normalize(Math2D.sub(h_pos, e_pos))
        offsets = (-0.65, 0.0, 0.65, -1.2, 1.2)
        flank_ang = math.atan2(h_dir.y, h_dir.x) + math.pi + offsets[idx % len(offsets)]
        pref_dist = (
            180.0
            if enemy.archetype == EnemyArchetype.SCOUT.value
            else 270.0
            if enemy.archetype == EnemyArchetype.HEAVY.value
            else 420.0
            if enemy.archetype == EnemyArchetype.SNIPER.value
            else 240.0
        )

        flank_pt = Vec2(h_pos.x + math.cos(flank_ang) * pref_dist, h_pos.y + math.sin(flank_ang) * pref_dist)
        steer = Math2D.scale(Math2D.normalize(Math2D.sub(flank_pt, e_pos)), enemy.maxSpeed)

        for o in all_enemies:
            if o.id == enemy.id or not o.isAlive:
                continue
            d = Math2D.dist(e_pos, o)
            if 0.001 < d < 65.0:
                steer = Math2D.add(steer, Math2D.scale(Math2D.sub(e_pos, o), (65.0 - d) * 5.0))

        for i in range(8):
            ang = (i * TAU) / 8.0
            r_dir = Vec2(math.cos(ang), math.sin(ang))
            for obs in obstacles:
                hit = Math2D.raycast_circle_intersection(e_pos, r_dir, obs, obs.radius, 60.0)
                if hit is not None:
                    steer = Math2D.add(steer, Math2D.scale(hit["normal"], (60.0 - hit["dist"]) * 6.0))

        m = padding + 25.0
        if enemy.x < m:
            steer.x += (m - enemy.x) * 12.0
        if enemy.x > arena_w - m:
            steer.x -= (enemy.x - (arena_w - m)) * 12.0
        if enemy.y < m:
            steer.y += (m - enemy.y) * 12.0
        if enemy.y > arena_h - m:
            steer.y -= (enemy.y - (arena_h - m)) * 12.0

        has_los = Math2D.test_minkowski_capsule_collision(e_pos, h_pos, obstacles, 3.5, 1.5)
        lead_t = Math2D.clamp(dist / (enemy.bulletSpeed or 420.0), 0.0, 0.4)
        lead_pt = Vec2(hero.x + hero.vx * lead_t, hero.y + hero.vy * lead_t)
        aim_dir = Math2D.normalize(Math2D.sub(lead_pt, e_pos))
        is_aimed = Math2D.dot(Vec2(math.cos(enemy.aimAngle), math.sin(enemy.aimAngle)), aim_dir) > 0.88
        spd = Math2D.length(steer)

        return {
            "targetVelocity": Math2D.scale(Math2D.normalize(steer), enemy.maxSpeed) if spd > enemy.maxSpeed else steer,
            "aimAngle": math.atan2(aim_dir.y, aim_dir.x),
            "shouldFire": has_los and is_aimed and enemy.fireCooldown <= 0.0 and dist < 650.0,
        }
# endregion


# region 1.8: BallisticsAndPBDPhysics
class EsperWorldAdapter:
    """Unified Entity Component System (ECS) adapter for Esper (compatible with Esper 2.x and 3.x)."""

    @staticmethod
    def clear() -> None:
        if hasattr(esper, "clear_database"):
            esper.clear_database()

    @staticmethod
    def create_entity(*components: Any) -> int:
        if hasattr(esper, "create_entity"):
            return int(esper.create_entity(*components))
        return -1

    @staticmethod
    def delete_entity(entity_id: int) -> None:
        if entity_id >= 0 and hasattr(esper, "delete_entity"):
            try:
                esper.delete_entity(entity_id, immediate=True)
            except Exception:
                pass


class ContinuousBallisticsProjectileSystem:
    """CCD projectile kinematics & Snell-Descartes specular ricochets."""

    def __init__(self) -> None:
        self._id_counter: int = 1
        self.projectiles: list[ProjectileEntity] = []
        self.burst_queue: list[dict[str, float]] = []

    def fire_hero_weapon(self, hero: AgentEntity, cfg: dict[str, Any]) -> None:
        hero.fireCooldown = 1.0 / max(0.05, float(hero.fireRate))
        hero.muzzleFlash = 1.0
        w_type = str(cfg.get("heroWeaponType", WeaponType.SINGLE.value))
        spd = float(cfg.get("heroBulletSpeed", 400.0))
        dmg = float(cfg.get("heroDamage", 5.0))
        b = int(cfg.get("bulletBounces", 0))

        if w_type == WeaponType.SHOTGUN.value:
            for i in range(5):
                self.fire_single_projectile(
                    hero,
                    spd * (0.9 + random.random() * 0.2),
                    dmg * 0.55,
                    (i / 4.0 - 0.5) * math.pi * 0.22,
                    b,
                    False,
                )
        elif w_type == WeaponType.BURST.value:
            self.fire_single_projectile(hero, spd, dmg * 0.85, 0.0, b, False)
            self.burst_queue.append({"delay": 0.07, "angleOffset": (random.random() - 0.5) * 0.04})
            self.burst_queue.append({"delay": 0.14, "angleOffset": (random.random() - 0.5) * 0.04})
        elif w_type == WeaponType.RAILGUN.value:
            self.fire_single_projectile(hero, spd * 1.6, dmg * 1.75, 0.0, b + 1, True)
        else:
            self.fire_single_projectile(hero, spd, dmg, 0.0, b, False)

    def fire_single_projectile(
        self,
        agent: AgentEntity,
        speed: float,
        damage: float,
        angle_offset: float = 0.0,
        bounces: int = 0,
        is_railgun: bool = False,
    ) -> None:
        if agent.type == AgentType.ENEMY.value:
            agent.fireCooldown = 1.0 / max(0.05, float(agent.fireRate))
            agent.muzzleFlash = 1.0
        b_len = agent.radius + 6.0
        ang = agent.aimAngle + angle_offset
        sx = agent.x + math.cos(ang) * b_len
        sy = agent.y + math.sin(ang) * b_len
        is_h = agent.type == AgentType.HERO.value

        trail_dq: deque[Vec2] = deque([Vec2(sx, sy)], maxlen=12 if is_railgun else 5)
        proj = ProjectileEntity(
            id=self._id_counter,
            shooterId=agent.id,
            shooterType=agent.type,
            x=sx,
            y=sy,
            vx=math.cos(ang) * speed,
            vy=math.sin(ang) * speed,
            radius=5.0 if is_railgun else (3.6 if is_h else 3.0),
            damage=damage,
            bouncesRemaining=int(bounces),
            isRailgun=is_railgun,
            trail=trail_dq,
            alive=True,
            distanceTraveled=0.0,
            maxDistance=1400.0 if is_railgun else 950.0,
            color=(
                "oklch(0.88 0.24 285)"
                if is_railgun
                else ("oklch(0.86 0.22 195)" if is_h else (agent.color or "oklch(0.68 0.26 15)"))
            ),
        )
        proj.ecs_entity = EsperWorldAdapter.create_entity(proj)
        self._id_counter += 1
        self.projectiles.append(proj)

    def update(
        self,
        dt: float,
        hero: AgentEntity,
        enemies: list[AgentEntity],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        cfg: dict[str, Any],
    ) -> None:
        for i in range(len(self.burst_queue) - 1, -1, -1):
            item = self.burst_queue[i]
            item["delay"] -= dt
            if item["delay"] <= 0.0:
                if hero.isAlive:
                    is_rg = cfg.get("heroWeaponType") == WeaponType.RAILGUN.value
                    self.fire_single_projectile(
                        hero,
                        float(cfg.get("heroBulletSpeed", 400.0)),
                        float(cfg.get("heroDamage", 5.0)),
                        item["angleOffset"],
                        3 if is_rg else int(cfg.get("bulletBounces", 0)),
                        is_rg,
                    )
                self.burst_queue.pop(i)

        for p in self.projectiles:
            if not p.alive:
                continue
            px = p.x
            py = p.y
            sx = p.vx * dt
            sy = p.vy * dt
            s_dist = math.hypot(sx, sy)
            p.x += sx
            p.y += sy
            p.distanceTraveled += s_dist
            p.trail.append(Vec2(p.x, p.y))
            if p.distanceTraveled >= p.maxDistance:
                p.alive = False
                EsperWorldAdapter.delete_entity(p.ecs_entity)
                continue

            if p.x <= padding or p.x >= arena_w - padding:
                if p.bouncesRemaining > 0:
                    p.vx = -p.vx
                    p.x = Math2D.clamp(p.x, padding + 2.0, arena_w - padding - 2.0)
                    p.bouncesRemaining -= 1
                else:
                    p.alive = False
                    EsperWorldAdapter.delete_entity(p.ecs_entity)
                    continue
            if p.y <= padding or p.y >= arena_h - padding:
                if p.bouncesRemaining > 0:
                    p.vy = -p.vy
                    p.y = Math2D.clamp(p.y, padding + 2.0, arena_h - padding - 2.0)
                    p.bouncesRemaining -= 1
                else:
                    p.alive = False
                    EsperWorldAdapter.delete_entity(p.ecs_entity)
                    continue

            hit_obs = False
            p_prev = Vec2(px, py)
            p_step = Vec2(sx, sy)
            for o in obstacles:
                hit = Math2D.raycast_circle_intersection(p_prev, p_step, o, o.radius, s_dist + 2.0)
                if hit is not None:
                    if p.bouncesRemaining > 0:
                        refl = Math2D.specular_reflect(Vec2(p.vx, p.vy), hit["normal"])
                        p.vx = refl.x
                        p.vy = refl.y
                        p.x = hit["point"].x + hit["normal"].x * 2.0
                        p.y = hit["point"].y + hit["normal"].y * 2.0
                        p.bouncesRemaining -= 1
                    else:
                        p.alive = False
                        EsperWorldAdapter.delete_entity(p.ecs_entity)
                        hit_obs = True
                    break
            if hit_obs:
                continue

            targets = enemies if p.shooterType == AgentType.HERO.value else [hero]
            for t in targets:
                if not t.isAlive or t.id in p.hitAgents or Math2D.dist(p, t) > t.radius + p.radius:
                    continue
                p.hitAgents.add(t.id)
                t.health -= p.damage
                if t.type == AgentType.HERO.value:
                    t.timeSinceHit = 0.0
                if t.health <= 0.0:
                    t.health = 0.0
                    t.isAlive = False
                if not p.isRailgun:
                    p.alive = False
                    EsperWorldAdapter.delete_entity(p.ecs_entity)
                    break

        self.projectiles = [p for p in self.projectiles if p.alive]

    def reset(self) -> None:
        for p in self.projectiles:
            EsperWorldAdapter.delete_entity(p.ecs_entity)
        self.projectiles.clear()
        self.burst_queue.clear()
        self._id_counter = 1


class PositionBasedDynamicsPhysicsEngine:
    """Symplectic Euler integration & Position-Based Dynamics (PBD) relaxation."""

    @staticmethod
    def update_agents(
        agents: list[AgentEntity],
        obstacles: list[Obstacle],
        arena_w: float,
        arena_h: float,
        padding: float,
        dt: float,
    ) -> None:
        for a in agents:
            if not a.isAlive:
                continue
            if a.fireCooldown > 0.0:
                a.fireCooldown = max(0.0, a.fireCooldown - dt)
            if a.muzzleFlash > 0.0:
                a.muzzleFlash = max(0.0, a.muzzleFlash - dt * 5.0)

            dodging = a.type == AgentType.HERO.value and (
                a.emergencyDodge or math.hypot(a.dodgeImpulse.x, a.dodgeImpulse.y) > 1.0
            )
            base_rate = (0.88 if dodging else 0.62) if a.type == AgentType.HERO.value else 0.24
            alpha = 1.0 - ((1.0 - base_rate) ** (dt * 60.0))
            a.vx = Math2D.lerp(a.vx, a.targetVx, alpha)
            a.vy = Math2D.lerp(a.vy, a.targetVy, alpha)

            if a.type == AgentType.HERO.value and math.hypot(a.dodgeImpulse.x, a.dodgeImpulse.y) > 1.0:
                a.vx += a.dodgeImpulse.x
                a.vy += a.dodgeImpulse.y
                max_b = a.maxSpeed * (1.85 if a.emergencyDodge else 1.4)
                spd = math.hypot(a.vx, a.vy)
                if spd > max_b:
                    a.vx = (a.vx / spd) * max_b
                    a.vy = (a.vy / spd) * max_b
                a.dodgeImpulse = Vec2(0.0, 0.0)

            target_ang = math.atan2(a.vy, a.vx) if math.hypot(a.vx, a.vy) > 10.0 else a.aimAngle
            a.angle = Math2D.lerp_angle(a.angle, target_ang, 0.25)
            a.x += a.vx * dt
            a.y += a.vy * dt

            for o in obstacles:
                res = Math2D.resolve_minimum_translation_vector(a, a.radius, o)
                a.x = res.x
                a.y = res.y
            a.x = Math2D.clamp(a.x, padding + a.radius, arena_w - padding - a.radius)
            a.y = Math2D.clamp(a.y, padding + a.radius, arena_h - padding - a.radius)

        n_agents = len(agents)
        for i in range(n_agents):
            a1 = agents[i]
            if not a1.isAlive:
                continue
            for j in range(i + 1, n_agents):
                a2 = agents[j]
                if not a2.isAlive:
                    continue
                d = Math2D.dist(a1, a2)
                min_d = a1.radius + a2.radius
                if 0.001 < d < min_d:
                    ov = (min_d - d) * 0.5
                    nx = (a1.x - a2.x) / d
                    ny = (a1.y - a2.y) / d
                    a1.x += nx * ov
                    a1.y += ny * ov
                    a2.x -= nx * ov
                    a2.y -= ny * ov


class CombatSystem:
    """High-level combat orchestrator."""

    @staticmethod
    def update(
        state: Any,
        cfg: dict[str, Any],
        dt: float,
        arena_w: float,
        arena_h: float,
        padding: float,
        weapon_system: ContinuousBallisticsProjectileSystem,
    ) -> None:
        hero = state.hero
        enemies = state.enemies
        obstacles = state.obstacles
        projectiles = weapon_system.projectiles

        if hero.isAlive:
            plan = TacticalDecisionController.evaluate(
                hero, enemies, projectiles, obstacles, arena_w, arena_h, padding, cfg, dt
            )
            state.aperture_data = plan["apertureData"]
            state.anchor_pos = plan["anchorPos"]
            state.dvo_debug_candidates = plan["dvoDebugCandidates"]
            state.ballistic_solution = plan["ballisticSolution"]
            state.target_score_table = plan["targetScoreTable"]

            hero.targetVx = plan["targetVelocity"].x
            hero.targetVy = plan["targetVelocity"].y
            hero.aimAngle = plan["aimAngle"]
            hero.state = plan["state"]
            hero.dodgeImpulse = plan["dodgeImpulse"]
            hero.emergencyDodge = bool(plan["emergencyDodge"])
            if plan["shouldFire"]:
                weapon_system.fire_hero_weapon(hero, cfg)

        for idx, enemy in enumerate(enemies):
            if not enemy.isAlive:
                continue
            dec = EnemyAIController.update_enemy(
                enemy, hero, enemies, obstacles, arena_w, arena_h, padding, idx
            )
            enemy.targetVx = dec["targetVelocity"].x
            enemy.targetVy = dec["targetVelocity"].y
            enemy.aimAngle = Math2D.lerp_angle(enemy.aimAngle, dec["aimAngle"], 0.2)
            if dec["shouldFire"]:
                weapon_system.fire_single_projectile(
                    enemy,
                    float(enemy.bulletSpeed or cfg.get("enemyBulletSpeed", 400.0)),
                    float(enemy.damage or cfg.get("enemyDamage", 5.0)),
                    (random.random() - 0.5) * 0.05,
                    0,
                    False,
                )
# endregion
# endregion


# region 2: SimulationAndWorldEngine
# region 2.1: WaveDirectorAndArenaPresets
class WaveDirector:
    """Scaled wave progression & archetype generator."""

    @staticmethod
    def generate_wave_enemies(
        wave: int, config: dict[str, Any], arena_w: float, arena_h: float, hero: AgentEntity
    ) -> list[AgentEntity]:
        cx = arena_w * 0.5
        cy = arena_h * 0.5
        r_dist = min(arena_w, arena_h) * 0.38
        count = min(
            64,
            max(2, math.floor((2.0 + wave * 0.95) * float(config.get("swarmMultiplier", 1.0)))),
        )
        enemies: list[AgentEntity] = []

        for i in range(count):
            ang = (i * TAU) / count + wave * 0.35
            sx = Math2D.clamp(cx + math.cos(ang) * r_dist, 80.0, arena_w - 80.0)
            sy = Math2D.clamp(cy + math.sin(ang) * r_dist, 80.0, arena_h - 80.0)
            if Math2D.dist(Vec2(sx, sy), hero) < 220.0:
                sx = cx + (-140.0 if sx > cx else 140.0)
                sy = cy + (-140.0 if sy > cy else 140.0)

            if wave >= 2 and i % 4 == 1:
                archetype = EnemyArchetype.SCOUT.value
            elif wave >= 3 and i % 5 == 2:
                archetype = EnemyArchetype.HEAVY.value
            elif wave >= 5 and i % 6 == 3:
                archetype = EnemyArchetype.SNIPER.value
            else:
                archetype = EnemyArchetype.STANDARD.value

            health = float(round(float(config.get("enemyHealth", 45.0)) + wave * 2.2))
            max_speed = float(config.get("enemySpeed", 230.0))
            fire_rate = float(config.get("enemyFireRate", 1.8))
            bullet_speed = float(config.get("enemyBulletSpeed", 420.0))
            damage = float(config.get("enemyDamage", 16.0))
            radius = 6.0
            color = "oklch(0.68 0.26 15)"

            if archetype == EnemyArchetype.SCOUT.value:
                health = float(round(health * 0.72))
                max_speed = float(round(max_speed * 1.25))
                fire_rate = round(fire_rate * 12.0) / 10.0
                radius = 5.0
                color = "oklch(0.74 0.28 330)"
            elif archetype == EnemyArchetype.HEAVY.value:
                health = float(round(health * 1.6))
                max_speed = float(round(max_speed * 0.8))
                fire_rate = round(fire_rate * 7.5) / 10.0
                damage = float(round(damage * 1.35))
                radius = 8.0
                color = "oklch(0.62 0.24 40)"
            elif archetype == EnemyArchetype.SNIPER.value:
                health = float(round(health * 0.85))
                bullet_speed = float(round(bullet_speed * 1.4))
                damage = float(round(damage * 1.6))
                fire_rate = round(fire_rate * 6.0) / 10.0
                radius = 6.0
                color = "oklch(0.70 0.25 140)"

            facing = math.atan2(hero.y - sy, hero.x - sx)
            enemy = AgentEntity(
                id=f"hostile-w{wave}-{i + 1}",
                type=AgentType.ENEMY.value,
                archetype=archetype,
                x=sx,
                y=sy,
                vx=0.0,
                vy=0.0,
                targetVx=0.0,
                targetVy=0.0,
                angle=facing,
                aimAngle=facing,
                radius=radius,
                maxSpeed=max_speed,
                health=health,
                maxHealth=health,
                isAlive=True,
                fireCooldown=0.3 + i * 0.15,
                fireRate=fire_rate,
                bulletSpeed=bullet_speed,
                damage=damage,
                color=color,
                muzzleFlash=0.0,
            )
            enemy.ecs_entity = EsperWorldAdapter.create_entity(enemy)
            enemies.append(enemy)

        return enemies


class ArenaPresets:
    """Procedural & architectural obstacle layouts."""

    @staticmethod
    def get_arena(
        layout: str, round_num: int, width: float = 1200.0, height: float = 800.0
    ) -> dict[str, Any]:
        config = {"width": width, "height": height, "padding": 24.0}
        cx = width / 2.0
        cy = height / 2.0

        def hex_layout(r: float, rad: float) -> list[Obstacle]:
            obs = [
                Obstacle(
                    id=i + 1,
                    x=cx + math.cos((i * math.pi) / 3.0) * r,
                    y=cy + math.sin((i * math.pi) / 3.0) * r,
                    radius=rad,
                )
                for i in range(6)
            ]
            obs.append(Obstacle(id=7, x=cx, y=cy, radius=rad - 6.0))
            return obs

        def quad_layout(dx: float, dy: float, r: float, cr: float) -> list[Obstacle]:
            return [
                Obstacle(id=1, x=cx - dx, y=cy - dy, radius=r),
                Obstacle(id=2, x=cx + dx, y=cy - dy, radius=r),
                Obstacle(id=3, x=cx - dx, y=cy + dy, radius=r),
                Obstacle(id=4, x=cx + dx, y=cy + dy, radius=r),
                Obstacle(id=5, x=cx, y=cy, radius=cr),
            ]

        if layout == ArenaLayout.PILLARS.value:
            return {"config": config, "obstacles": hex_layout(250.0, 46.0)}
        if layout == ArenaLayout.BUNKERS.value:
            return {"config": config, "obstacles": quad_layout(280.0, 120.0, 54.0, 64.0)}
        if layout == ArenaLayout.FORTRESS.value:
            return {
                "config": config,
                "obstacles": [
                    Obstacle(id=1, x=cx - 220.0, y=cy, radius=50.0),
                    Obstacle(id=2, x=cx + 220.0, y=cy, radius=50.0),
                    Obstacle(id=3, x=cx, y=cy - 170.0, radius=50.0),
                    Obstacle(id=4, x=cx, y=cy + 170.0, radius=50.0),
                    Obstacle(id=5, x=cx - 360.0, y=cy - 200.0, radius=40.0),
                    Obstacle(id=6, x=cx + 360.0, y=cy - 200.0, radius=40.0),
                    Obstacle(id=7, x=cx - 360.0, y=cy + 200.0, radius=40.0),
                    Obstacle(id=8, x=cx + 360.0, y=cy + 200.0, radius=40.0),
                ],
            }
        if layout == ArenaLayout.OPEN.value:
            return {
                "config": config,
                "obstacles": [
                    Obstacle(id=1, x=cx - 320.0, y=cy, radius=36.0),
                    Obstacle(id=2, x=cx + 320.0, y=cy, radius=36.0),
                ],
            }

        idx = (round_num - 1) % 5
        if idx == 0:
            obs_list = quad_layout(240.0, 140.0, 46.0, 56.0)
        elif idx == 1:
            q = quad_layout(100.0, 190.0, 44.0, 48.0)
            obs_list = [
                Obstacle(id=1, x=cx - 300.0, y=cy, radius=60.0),
                Obstacle(id=2, x=cx + 300.0, y=cy, radius=60.0),
                *[Obstacle(id=i + 3, x=o.x, y=o.y, radius=o.radius) for i, o in enumerate(q)],
            ]
        elif idx == 2:
            obs_list = [
                Obstacle(id=1, x=cx - 210.0, y=cy - 130.0, radius=52.0),
                Obstacle(id=2, x=cx + 210.0, y=cy + 130.0, radius=52.0),
                Obstacle(id=3, x=cx - 330.0, y=cy + 140.0, radius=42.0),
                Obstacle(id=4, x=cx + 330.0, y=cy - 140.0, radius=42.0),
                Obstacle(id=5, x=cx, y=cy, radius=64.0),
            ]
        elif idx == 3:
            obs_list = quad_layout(240.0, 190.0, 48.0, 50.0)
        else:
            obs_list = hex_layout(230.0, 44.0)

        return {"config": config, "obstacles": obs_list}
# endregion


# region 2.2: LifecycleAndSimulationCore
class RoundLifecycleManager:
    """Round transitions, hero state & shield regeneration lifecycle."""

    def __init__(self) -> None:
        self.wave: int = 1
        self.waves_cleared: int = 0
        self.round_over_timer: float = 0.0
        self.is_round_over: bool = False
        self.winner: Optional[str] = None
        self.time_scale: float = 1.0
        self.hero: Optional[AgentEntity] = None
        self.enemies: list[AgentEntity] = []
        self.obstacles: list[Obstacle] = []
        self.aperture_data: Optional[dict[str, Any]] = None
        self.anchor_pos: Optional[Vec2] = None
        self.dvo_debug_candidates: list[DVOCandidate] = []
        self.ballistic_solution: Optional[dict[str, Any]] = None
        self.target_score_table: list[dict[str, Any]] = []

    def init_round(
        self,
        wave: int,
        waves_cleared: int,
        preserved_hero: Optional[AgentEntity],
        store: Any,
        width: float,
        height: float,
    ) -> None:
        EsperWorldAdapter.clear()
        arena = ArenaPresets.get_arena(
            store.get("arenaLayout"), 1 + (wave - 1) // 3, width, height
        )
        self.obstacles = arena["obstacles"]
        for obs in self.obstacles:
            EsperWorldAdapter.create_entity(obs)

        cfg = store.get_all()
        if preserved_hero is not None and preserved_hero.isAlive:
            self.hero = dataclasses.replace(
                preserved_hero,
                maxHealth=float(cfg["heroHealth"]),
                health=float(cfg["heroHealth"]),
                maxSpeed=float(cfg["heroSpeed"]),
                fireRate=float(cfg["heroFireRate"]),
                vx=0.0,
                vy=0.0,
                targetVx=0.0,
                targetVy=0.0,
                fireCooldown=0.1,
                dodgeImpulse=Vec2(0.0, 0.0),
                emergencyDodge=False,
                timeSinceHit=99.0,
            )
        else:
            self.hero = AgentEntity(
                id="hero-1",
                type=AgentType.HERO.value,
                x=width * 0.5,
                y=height * 0.5,
                vx=0.0,
                vy=0.0,
                targetVx=0.0,
                targetVy=0.0,
                angle=-math.pi / 2.0,
                aimAngle=-math.pi / 2.0,
                radius=7.0,
                maxSpeed=float(cfg["heroSpeed"]),
                health=float(cfg["heroHealth"]),
                maxHealth=float(cfg["heroHealth"]),
                isAlive=True,
                fireCooldown=0.0,
                fireRate=float(cfg["heroFireRate"]),
                state=TacticalState.ISOLATE_AND_ENGAGE.value,
                color="oklch(0.86 0.22 195)",
                muzzleFlash=0.0,
                dodgeImpulse=Vec2(0.0, 0.0),
                emergencyDodge=False,
                timeSinceHit=99.0,
            )

        self.hero.ecs_entity = EsperWorldAdapter.create_entity(self.hero)
        self.enemies = WaveDirector.generate_wave_enemies(wave, cfg, width, height, self.hero)
        self.wave = wave
        self.waves_cleared = waves_cleared
        self.round_over_timer = 0.0
        self.is_round_over = False
        self.winner = None
        self.time_scale = 1.0
        self.aperture_data = None
        self.anchor_pos = None
        self.dvo_debug_candidates = []
        self.ballistic_solution = None
        self.target_score_table = []

    def rebuild_obstacles(self, store: Any, width: float, height: float) -> None:
        self.obstacles = ArenaPresets.get_arena(
            store.get("arenaLayout"), 1 + (self.wave - 1) // 3, width, height
        )["obstacles"]

    def sync_hero_specs(self, store: Any) -> None:
        h = self.hero
        if h is None or not h.isAlive:
            return
        h.maxSpeed = float(store.get("heroSpeed"))
        h.fireRate = float(store.get("heroFireRate"))
        new_max = float(store.get("heroHealth"))
        ratio = h.health / max(1.0, h.maxHealth)
        h.maxHealth = new_max
        h.health = min(new_max, max(1.0, float(round(new_max * ratio))))

    def update(
        self,
        dt: float,
        effective_dt: float,
        cfg: dict[str, Any],
        is_step: bool,
        on_transition: Callable[[bool], None],
    ) -> bool:
        assert self.hero is not None
        if not self.is_round_over:
            if not any(e.isAlive for e in self.enemies):
                self.is_round_over = True
                self.winner = AgentType.HERO.value
                self.round_over_timer = 0.9
                self.time_scale = 0.45
            elif not self.hero.isAlive:
                self.is_round_over = True
                self.winner = AgentType.ENEMY.value
                self.round_over_timer = 1.3
                self.time_scale = 0.4
        elif not is_step:
            self.round_over_timer -= dt
            if self.round_over_timer <= 0.0:
                on_transition(self.winner == AgentType.HERO.value)
                return False

        regen = float(cfg.get("heroRegenRate", 0.0))
        if self.hero.isAlive and regen > 0.0:
            self.hero.timeSinceHit = (self.hero.timeSinceHit or 0.0) + effective_dt
            if self.hero.timeSinceHit > 1.5 and self.hero.health < self.hero.maxHealth:
                self.hero.health = min(self.hero.maxHealth, self.hero.health + regen * effective_dt)
        return True


class Simulation:
    """Main simulation coordinator."""

    def __init__(self, store: Any, width: float = 1200.0, height: float = 800.0) -> None:
        self._store = store
        self._arena_width = width
        self._arena_height = height
        self._padding = 24.0
        self._is_paused = False
        self._round_manager = RoundLifecycleManager()
        self._projectile_system = ContinuousBallisticsProjectileSystem()

        start_w = int(self._store.get("startWave") or 1)
        self._round_manager.init_round(start_w, 0, None, self._store, width, height)

        def on_config_change(key: str, _val: Any) -> None:
            if key == "arenaLayout":
                self._round_manager.rebuild_obstacles(self._store, self._arena_width, self._arena_height)
            elif key in ("heroSpeed", "heroFireRate", "heroHealth"):
                self._round_manager.sync_hero_specs(self._store)

        self._store.subscribe(on_config_change)

    @property
    def state(self) -> dict[str, Any]:
        return {
            "hero": self._round_manager.hero,
            "enemies": self._round_manager.enemies,
            "obstacles": self._round_manager.obstacles,
            "projectiles": self._projectile_system.projectiles,
            "wave": self._round_manager.wave,
            "wavesCleared": self._round_manager.waves_cleared,
            "roundOverTimer": self._round_manager.round_over_timer,
            "isRoundOver": self._round_manager.is_round_over,
            "winner": self._round_manager.winner,
            "timeScale": self._round_manager.time_scale,
            "apertureData": self._round_manager.aperture_data,
            "anchorPos": self._round_manager.anchor_pos,
            "dvoDebugCandidates": self._round_manager.dvo_debug_candidates,
            "ballisticSolution": self._round_manager.ballistic_solution,
            "targetScoreTable": self._round_manager.target_score_table,
        }

    @property
    def config(self) -> dict[str, Any]:
        return self._store.get_all()

    @property
    def is_paused(self) -> bool:
        return self._is_paused

    def toggle_pause(self) -> bool:
        self._is_paused = not self._is_paused
        return self._is_paused

    def step_once(self, dt: float = 1.0 / 60.0) -> None:
        self._update_simulation(dt, True)

    def jump_to_wave(self, wave: int) -> None:
        TacticalKinematicObserver.reset()
        self._projectile_system.reset()
        self._round_manager.init_round(
            max(1, int(wave)), 0, None, self._store, self._arena_width, self._arena_height
        )

    def reset_simulation(self) -> None:
        self.jump_to_wave(int(self._store.get("startWave") or 1))

    def update(self, dt: float) -> None:
        if not self._is_paused:
            self._update_simulation(dt, False)

    def _update_simulation(self, dt: float, is_step: bool = False) -> None:
        cfg = self._store.get_all()
        effective_dt = dt * self._round_manager.time_scale * float(cfg.get("timeScale", 1.0))

        def handle_transition(hero_won: bool) -> None:
            self._projectile_system.reset()
            next_wave = self._round_manager.wave + 1 if hero_won else int(cfg.get("startWave") or 1)
            next_cleared = self._round_manager.waves_cleared + 1 if hero_won else 0
            preserved = self._round_manager.hero if hero_won else None
            self._round_manager.init_round(
                next_wave, next_cleared, preserved, self._store, self._arena_width, self._arena_height
            )

        active = self._round_manager.update(dt, effective_dt, cfg, is_step, handle_transition)
        if not active or self._round_manager.hero is None:
            return

        CombatSystem.update(
            self._round_manager,
            cfg,
            effective_dt,
            self._arena_width,
            self._arena_height,
            self._padding,
            self._projectile_system,
        )
        PositionBasedDynamicsPhysicsEngine.update_agents(
            [self._round_manager.hero, *self._round_manager.enemies],
            self._round_manager.obstacles,
            self._arena_width,
            self._arena_height,
            self._padding,
            effective_dt,
        )
        self._projectile_system.update(
            effective_dt,
            self._round_manager.hero,
            self._round_manager.enemies,
            self._round_manager.obstacles,
            self._arena_width,
            self._arena_height,
            self._padding,
            cfg,
        )
# endregion
# endregion


# region 3: RenderingPipeline
# region 3.1: EnvironmentAndOverlayRenderers
DASH_EMPTY = to_js([])
DASH_2_2 = to_js([2, 2])
DASH_3_3 = to_js([3, 3])
DASH_4_4 = to_js([4, 4])


class EnvironmentRenderer:
    @staticmethod
    def draw_floor(ctx: Any, width: float, height: float, padding: float) -> None:
        ctx.strokeStyle = "oklch(0.24 0.01 240 / 0.7)"
        ctx.lineWidth = 1.5
        ctx.strokeRect(padding, padding, width - padding * 2.0, height - padding * 2.0)
        ctx.strokeStyle = "oklch(0.20 0.01 240 / 0.4)"
        ctx.beginPath()
        ctx.arc(width / 2.0, height / 2.0, 70.0, 0.0, TAU)
        ctx.stroke()

    @staticmethod
    def draw_obstacles(ctx: Any, obstacles: list[Obstacle]) -> None:
        for o in obstacles:
            ctx.fillStyle = "oklch(0.12 0.01 240)"
            ctx.strokeStyle = "oklch(0.30 0.01 240)"
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.arc(o.x, o.y, o.radius, 0.0, TAU)
            ctx.fill()
            ctx.stroke()


class TacticalOverlayRenderer:
    """Diagnostic HUD & tactical telemetry visualizers."""

    @staticmethod
    def render_ground_overlays(ctx: Any, state: dict[str, Any], config: dict[str, Any]) -> None:
        if not config.get("showPotentialField"):
            return
        grid_data = KhatibArtificialPotentialFieldEngine.get_grid_data()
        grid = grid_data["grid"]
        if grid is None:
            return
        rows = grid_data["rows"]
        cols = grid_data["cols"]
        cell_size = grid_data["cellSize"]

        ctx.save()
        for ry in range(rows):
            for rx in range(cols):
                val = float(grid[ry, rx])
                if val <= 0.0:
                    continue
                n = min(1.0, val / 2500.0)
                ctx.fillStyle = (
                    f"oklch({0.25 + n * 0.45:.3f} {0.15 + n * 0.15:.3f} "
                    f"{15.0 + n * 40.0:.1f} / {0.05 + n * 0.40:.3f})"
                )
                ctx.fillRect(rx * cell_size, ry * cell_size, cell_size, cell_size)
        ctx.restore()

    @staticmethod
    def render_combat_overlays(ctx: Any, state: dict[str, Any], config: dict[str, Any]) -> None:
        hero: Optional[AgentEntity] = state.get("hero")
        is_alive = bool(hero and hero.isAlive)

        if config.get("showPerimeterRings") and is_alive and hero is not None:
            ctx.save()
            ctx.translate(hero.x, hero.y)
            ctx.lineWidth = 1.0
            ctx.setLineDash(DASH_4_4)
            ctx.strokeStyle = "oklch(0.86 0.22 195 / 0.35)"
            ctx.beginPath()
            ctx.arc(0.0, 0.0, float(config.get("kitingDistance", 240.0)), 0.0, TAU)
            ctx.stroke()
            ctx.strokeStyle = "oklch(0.75 0.22 45 / 0.35)"
            ctx.beginPath()
            ctx.arc(0.0, 0.0, 180.0, 0.0, TAU)
            ctx.stroke()
            ctx.strokeStyle = "oklch(0.68 0.26 15 / 0.5)"
            ctx.setLineDash(DASH_2_2)
            ctx.beginPath()
            ctx.arc(0.0, 0.0, hero.radius + float(config.get("dvoSafetyRadius", 16.0)), 0.0, TAU)
            ctx.stroke()
            ctx.restore()

        aperture_data = state.get("apertureData")
        if (
            config.get("showEnclosureSectors")
            and is_alive
            and hero is not None
            and aperture_data
            and aperture_data.get("pinchWedges")
        ):
            ctx.save()
            ctx.translate(hero.x, hero.y)
            ctx.fillStyle = "oklch(0.68 0.26 15 / 0.12)"
            ctx.strokeStyle = "oklch(0.68 0.26 15 / 0.35)"
            ctx.lineWidth = 1.0
            for w in aperture_data["pinchWedges"]:
                ctx.beginPath()
                ctx.moveTo(0.0, 0.0)
                ctx.arc(0.0, 0.0, 130.0, w["start"], w["end"])
                ctx.closePath()
                ctx.fill()
                ctx.stroke()
            ctx.restore()

        anchor_pos: Optional[Vec2] = state.get("anchorPos")
        if config.get("showTacticalAnchors") and anchor_pos is not None and hero is not None:
            ctx.save()
            ctx.strokeStyle = "oklch(0.86 0.22 195 / 0.45)"
            ctx.setLineDash(DASH_4_4)
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.moveTo(hero.x, hero.y)
            ctx.lineTo(anchor_pos.x, anchor_pos.y)
            ctx.stroke()
            ctx.fillStyle = "oklch(0.86 0.22 195 / 0.7)"
            ctx.beginPath()
            ctx.arc(anchor_pos.x, anchor_pos.y, 5.0, 0.0, TAU)
            ctx.fill()
            ctx.restore()

        if config.get("showEscapeAperture") and is_alive and hero is not None and aperture_data:
            best_ang = aperture_data["bestApertureAngle"]
            is_cp = aperture_data["isCornerPinch"]
            is_et = aperture_data["isEnclosureTrap"]
            is_brk = hero.state == TacticalState.BREAKOUT.value
            ctx.save()
            ctx.translate(hero.x, hero.y)
            ctx.fillStyle = (
                "oklch(0.85 0.26 90 / 0.12)" if is_brk else "oklch(0.80 0.18 195 / 0.06)"
            )
            ctx.strokeStyle = (
                "oklch(0.85 0.26 90 / 0.8)"
                if is_brk
                else ("oklch(0.75 0.22 45 / 0.6)" if (is_cp or is_et) else "oklch(0.80 0.18 195 / 0.4)")
            )
            ctx.lineWidth = 2.0 if is_brk else 1.0
            ctx.beginPath()
            ctx.moveTo(0.0, 0.0)
            ctx.arc(0.0, 0.0, 220.0, best_ang - math.pi * 0.175, best_ang + math.pi * 0.175)
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
            ctx.restore()

        dvo_cands: list[DVOCandidate] = state.get("dvoDebugCandidates") or []
        if config.get("showDVOCandidates") and is_alive and hero is not None and dvo_cands:
            ctx.save()
            ctx.translate(hero.x, hero.y)
            ctx.lineWidth = 1.0
            max_spd = hero.maxSpeed or 320.0
            for c in dvo_cands:
                length = (c.speed / max_spd) * 48.0
                if length < 2.0:
                    continue
                p_n = min(1.0, c.penalty / 50000.0)
                ctx.strokeStyle = f"oklch({0.80 - p_n * 0.3:.2f} 0.22 {140.0 - p_n * 125.0:.1f} / 0.45)"
                ctx.beginPath()
                ctx.moveTo(0.0, 0.0)
                ctx.lineTo(c.dir.x * length, c.dir.y * length)
                ctx.stroke()
            ctx.restore()

        if config.get("showThreatVectors"):
            ctx.save()
            ctx.lineWidth = 1.0
            ctx.setLineDash(DASH_3_3)
            ctx.strokeStyle = "oklch(0.68 0.26 15 / 0.35)"
            for p in state.get("projectiles", []):
                if not p.alive or p.shooterType == AgentType.HERO.value:
                    continue
                ctx.beginPath()
                ctx.moveTo(p.x, p.y)
                ctx.lineTo(p.x + p.vx * 0.6, p.y + p.vy * 0.6)
                ctx.stroke()
            ctx.restore()

        if config.get("showVelocityVectors") and hero is not None:
            ctx.save()
            ctx.lineWidth = 1.5
            for ag in [hero, *state.get("enemies", [])]:
                if not ag.isAlive or math.hypot(ag.vx, ag.vy) < 5.0:
                    continue
                ctx.strokeStyle = (
                    "oklch(0.86 0.22 195 / 0.7)"
                    if ag.type == AgentType.HERO.value
                    else "oklch(0.68 0.26 15 / 0.5)"
                )
                ctx.beginPath()
                ctx.moveTo(ag.x, ag.y)
                ctx.lineTo(ag.x + ag.vx * 0.25, ag.y + ag.vy * 0.25)
                ctx.stroke()
            ctx.restore()

        ballistic_sol = state.get("ballisticSolution")
        if config.get("showBallisticLead") and is_alive and ballistic_sol is not None:
            pred: Vec2 = ballistic_sol["pos"]
            barrel_origin: Vec2 = ballistic_sol["barrelOrigin"]
            tof: float = ballistic_sol["time"]
            arc: list[Vec2] = ballistic_sol.get("projectedArc") or []
            ctx.save()
            if len(arc) > 1:
                ctx.strokeStyle = "oklch(0.88 0.24 285 / 0.6)"
                ctx.lineWidth = 1.5
                ctx.setLineDash(DASH_2_2)
                ctx.beginPath()
                ctx.moveTo(arc[0].x, arc[0].y)
                for pt in arc[1:]:
                    ctx.lineTo(pt.x, pt.y)
                ctx.stroke()
            ctx.strokeStyle = "oklch(0.88 0.24 285 / 0.55)"
            ctx.lineWidth = 1.0
            ctx.setLineDash(DASH_3_3)
            ctx.beginPath()
            ctx.moveTo(barrel_origin.x, barrel_origin.y)
            ctx.lineTo(pred.x, pred.y)
            ctx.stroke()
            ctx.setLineDash(DASH_EMPTY)
            ctx.strokeStyle = "oklch(0.88 0.24 285 / 0.9)"
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.arc(pred.x, pred.y, 7.0, 0.0, TAU)
            ctx.moveTo(pred.x - 11.0, pred.y)
            ctx.lineTo(pred.x + 11.0, pred.y)
            ctx.moveTo(pred.x, pred.y - 11.0)
            ctx.lineTo(pred.x, pred.y + 11.0)
            ctx.stroke()
            ctx.font = "9px ui-monospace, monospace"
            ctx.fillStyle = "oklch(0.88 0.24 285)"
            ctx.fillText(f"TOF:{tof * 1000.0:.0f}ms", pred.x + 12.0, pred.y - 6.0)
            ctx.restore()

        target_table = state.get("targetScoreTable") or []
        if config.get("showTargetAnalysis") and is_alive and target_table:
            ctx.save()
            ctx.font = "9px ui-monospace, monospace"
            for i, item in enumerate(target_table):
                e: AgentEntity = item["enemy"]
                score: float = item["score"]
                if not e.isAlive:
                    continue
                is_p = i == 0
                b = max(9.0, e.radius + 4.0)
                ctx.strokeStyle = "oklch(0.86 0.22 195 / 0.9)" if is_p else "oklch(0.70 0.01 240 / 0.4)"
                ctx.lineWidth = 1.5 if is_p else 1.0
                ctx.beginPath()
                for sx, sy in ((-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)):
                    ctx.moveTo(e.x + sx * b, e.y + sy * (b - 3.0))
                    ctx.lineTo(e.x + sx * b, e.y + sy * b)
                    ctx.lineTo(e.x + sx * (b - 3.0), e.y + sy * b)
                ctx.stroke()
                ctx.fillStyle = "oklch(0.86 0.22 195)" if is_p else "oklch(0.60 0.01 240)"
                ctx.fillText(f"#{i + 1} ({round(score)})", e.x + b + 3.0, e.y + 3.0)
            ctx.restore()

        ctx.lineWidth = 1.0
        if is_alive and hero is not None:
            ctx.strokeStyle = (
                "oklch(0.85 0.26 90 / 0.7)"
                if hero.state == TacticalState.BREAKOUT.value
                else "oklch(0.86 0.22 195 / 0.35)"
            )
            ctx.beginPath()
            ctx.moveTo(hero.x, hero.y)
            ctx.lineTo(hero.x + math.cos(hero.aimAngle) * 350.0, hero.y + math.sin(hero.aimAngle) * 350.0)
            ctx.stroke()

        ctx.strokeStyle = "oklch(0.68 0.26 15 / 0.22)"
        for e in state.get("enemies", []):
            if not e.isAlive:
                continue
            ctx.beginPath()
            ctx.moveTo(e.x, e.y)
            ctx.lineTo(e.x + math.cos(e.aimAngle) * 220.0, e.y + math.sin(e.aimAngle) * 220.0)
            ctx.stroke()
# endregion


# region 3.2: EntityHudAndCanvasRenderers
class EntityRenderer:
    @staticmethod
    def render(ctx: Any, state: dict[str, Any]) -> None:
        for p in state.get("projectiles", []):
            ctx.fillStyle = p.color
            ctx.beginPath()
            ctx.arc(p.x, p.y, p.radius, 0.0, TAU)
            ctx.fill()
            if len(p.trail) > 1:
                ctx.strokeStyle = p.color
                ctx.lineWidth = 3.0 if p.isRailgun else 1.5
                ctx.globalAlpha = 0.4
                ctx.beginPath()
                trail_list = list(p.trail)
                ctx.moveTo(trail_list[0].x, trail_list[0].y)
                for pt in trail_list[1:]:
                    ctx.lineTo(pt.x, pt.y)
                ctx.stroke()
                ctx.globalAlpha = 1.0

        hero: Optional[AgentEntity] = state.get("hero")
        agents = [*state.get("enemies", [])]
        if hero is not None:
            agents.append(hero)

        for agent in agents:
            if not agent or not agent.isAlive:
                continue
            ctx.save()
            ctx.translate(agent.x, agent.y)
            is_h = agent.type == AgentType.HERO.value
            r = agent.radius
            hp_r = max(0.0, agent.health / max(1.0, agent.maxHealth))
            col = (
                "oklch(0.85 0.26 90)"
                if (is_h and agent.state == TacticalState.BREAKOUT.value)
                else (agent.color or ("oklch(0.86 0.22 195)" if is_h else "oklch(0.68 0.26 15)"))
            )
            spd = math.hypot(agent.vx, agent.vy)
            if spd > 20.0:
                m_ang = math.atan2(agent.vy, agent.vx) + math.pi
                t_len = min(12.0, (spd / (agent.maxSpeed or 250.0)) * 10.0)
                ctx.strokeStyle = "oklch(0.86 0.22 195 / 0.45)" if is_h else "oklch(0.68 0.26 15 / 0.35)"
                ctx.lineWidth = 1.5
                ctx.beginPath()
                ctx.moveTo(math.cos(m_ang) * r, math.sin(m_ang) * r)
                ctx.lineTo(math.cos(m_ang) * (r + t_len), math.sin(m_ang) * (r + t_len))
                ctx.stroke()

            bw = max(16.0, r * 2.5)
            by = -r - 5.0
            ctx.strokeStyle = "oklch(0.20 0.01 240 / 0.8)"
            ctx.lineWidth = 2.0
            ctx.beginPath()
            ctx.moveTo(-bw / 2.0, by)
            ctx.lineTo(bw / 2.0, by)
            ctx.stroke()
            if hp_r > 0.0:
                ctx.strokeStyle = col
                ctx.beginPath()
                ctx.moveTo(-bw / 2.0, by)
                ctx.lineTo(-bw / 2.0 + bw * hp_r, by)
                ctx.stroke()

            b_len = r + 6.0
            ctx.strokeStyle = "oklch(0.98 0.005 240)"
            ctx.lineWidth = 2.0
            ctx.beginPath()
            ctx.moveTo(0.0, 0.0)
            ctx.lineTo(math.cos(agent.aimAngle) * b_len, math.sin(agent.aimAngle) * b_len)
            ctx.stroke()

            ctx.fillStyle = col
            ctx.beginPath()
            ctx.arc(0.0, 0.0, r, 0.0, TAU)
            ctx.fill()

            if agent.muzzleFlash > 0.0:
                ctx.fillStyle = f"oklch(0.98 0.20 90 / {agent.muzzleFlash:.2f})"
                ctx.beginPath()
                ctx.arc(math.cos(agent.aimAngle) * b_len, math.sin(agent.aimAngle) * b_len, 3.5, 0.0, TAU)
                ctx.fill()
            ctx.restore()


class HudRenderer:
    @staticmethod
    def render(ctx: Any, state: dict[str, Any], width: float, height: float, padding: float) -> None:
        hero: Optional[AgentEntity] = state.get("hero")
        if hero is None:
            return
        ctx.save()
        ctx.font = "11px ui-monospace, monospace"
        ctx.textAlign = "left"
        ctx.textBaseline = "top"
        alive_count = sum(1 for e in state.get("enemies", []) if e.isAlive)
        h_state = hero.state or "IDLE"
        ctx.fillStyle = (
            "oklch(0.85 0.26 90)"
            if h_state == TacticalState.BREAKOUT.value
            else "oklch(0.68 0.01 240)"
        )
        hud_text = (
            f"[Slippery Combat AI] WAVE:{state['wave']} (CLEARED:{state['wavesCleared']}) | "
            f"HERO HP:{max(0, round(hero.health))}/{round(hero.maxHealth)} | "
            f"HOSTILES:{alive_count} | BRAIN:{h_state}"
        )
        ctx.fillText(hud_text, padding + 6.0, padding + 6.0)

        if state.get("isRoundOver"):
            ctx.textAlign = "center"
            ctx.textBaseline = "middle"
            hero_won = state.get("winner") == AgentType.HERO.value
            ctx.fillStyle = "oklch(0.86 0.22 195)" if hero_won else "oklch(0.68 0.26 15)"
            ctx.font = "bold 16px ui-monospace, monospace"
            ctx.fillText(
                f"WAVE {state['wave']} CLEARED" if hero_won else "HERO DESTROYED",
                width / 2.0,
                height / 2.0,
            )
        ctx.restore()


class CanvasRenderer:
    @staticmethod
    def render(
        ctx: Any,
        state: dict[str, Any],
        canvas_w: float,
        canvas_h: float,
        arena_w: float,
        arena_h: float,
        padding: float,
        config: dict[str, Any],
    ) -> None:
        ctx.save()
        ctx.fillStyle = "oklch(0.06 0.005 240)"
        ctx.fillRect(0.0, 0.0, canvas_w, canvas_h)
        scale = min(canvas_w / arena_w, canvas_h / arena_h)
        ctx.translate((canvas_w - arena_w * scale) / 2.0, (canvas_h - arena_h * scale) / 2.0)
        ctx.scale(scale, scale)

        EnvironmentRenderer.draw_floor(ctx, arena_w, arena_h, padding)
        TacticalOverlayRenderer.render_ground_overlays(ctx, state, config)
        EnvironmentRenderer.draw_obstacles(ctx, state.get("obstacles", []))
        TacticalOverlayRenderer.render_combat_overlays(ctx, state, config)
        EntityRenderer.render(ctx, state)
        if config.get("showDiagnosticsHUD"):
            HudRenderer.render(ctx, state, arena_w, arena_h, padding)
        ctx.restore()
# endregion
# endregion


# region 4: ReactiveStoreUIAndMainLoop
# region 4.1: ReactiveConfigStore
class ConfigStore:
    """Pydantic schema-validated reactive configuration store with localStorage persistence."""

    def __init__(self, schema: dict[str, dict[str, Any]] = CONFIG_SCHEMA) -> None:
        self._schema = schema
        self._model = SimulationConfig()
        self.state: dict[str, Any] = self._model.model_dump()
        self._listeners: set[Callable[[str, Any], None]] = set()
        self._storage_key = "tactical_sim_config_store_v4"

        try:
            raw = js.localStorage.getItem(self._storage_key)
            if raw:
                parsed = json.loads(str(raw))
                if isinstance(parsed, dict):
                    for k, v in parsed.items():
                        if k in schema:
                            self.state[k] = self._validate(k, v)
        except Exception:
            pass

    def get(self, k: str) -> Any:
        return self.state.get(k)

    def get_all(self) -> dict[str, Any]:
        return dict(self.state)

    def set(self, k: str, val: Any, persist: bool = True) -> None:
        if k not in self._schema:
            return
        v = self._validate(k, val)
        self.state[k] = v
        if persist:
            self.save_to_storage()
        for fn in list(self._listeners):
            fn(k, v)

    def set_batch(self, updates: dict[str, Any], persist: bool = True) -> None:
        for k, v in updates.items():
            if k in self._schema:
                self.state[k] = self._validate(k, v)
        if persist:
            self.save_to_storage()
        for k in updates:
            if k in self._schema:
                for fn in list(self._listeners):
                    fn(k, self.state[k])

    def _validate(self, k: str, val: Any) -> Any:
        m = self._schema.get(k)
        if not m:
            return val
        if m["type"] == "boolean":
            validated = bool(val)
        elif m["type"] == "number":
            try:
                n = float(val)
                if not math.isfinite(n):
                    n = float(m["default"])
            except (TypeError, ValueError):
                n = float(m["default"])
            validated = Math2D.clamp(n, float(m.get("min", -math.inf)), float(m.get("max", math.inf)))
        else:
            validated = str(val)

        try:
            setattr(self._model, k, validated)
            return getattr(self._model, k)
        except Exception:
            return validated

    def subscribe(self, fn: Callable[[str, Any], None]) -> Callable[[], None]:
        self._listeners.add(fn)
        return lambda: self._listeners.discard(fn)

    def reset_defaults(self) -> None:
        self._model = SimulationConfig()
        for k, m in self._schema.items():
            self.state[k] = m["default"]
        try:
            js.localStorage.removeItem(self._storage_key)
        except Exception:
            pass
        for k in self._schema:
            for fn in list(self._listeners):
                fn(k, self.state[k])

    def export_json(self) -> str:
        return json.dumps(self.state, indent=2)

    def import_json(self, raw_str: str) -> bool:
        try:
            p = json.loads(raw_str)
            if isinstance(p, dict):
                self.set_batch(p)
                return True
        except Exception:
            pass
        return False

    def save_to_storage(self) -> None:
        try:
            js.localStorage.setItem(self._storage_key, json.dumps(self.state))
        except Exception:
            pass
# endregion


# region 4.2: LilGuiUIManager
class UIManager:
    """lil-gui controller manager & responsive DPR canvas observer."""

    def __init__(
        self,
        GUI: Any,
        sim: Simulation,
        store: ConfigStore,
        container: Any,
        canvas: Any,
        ctx: Any,
        toast_el: Any,
    ) -> None:
        self._GUI = GUI
        self._sim = sim
        self._store = store
        self._container = js.document.querySelector(container) if isinstance(container, str) else container
        self._canvas = js.document.querySelector(canvas) if isinstance(canvas, str) else canvas
        self._ctx = ctx
        self._toast_el = js.document.querySelector(toast_el) if isinstance(toast_el, str) else toast_el
        self._toast_timeout: Optional[Any] = None
        self._resize_observer: Optional[Any] = None
        self._proxies: list[Any] = []
        self._js_state = to_js_obj(self._store.state)
        self._gui: Any = None

        self._init_gui()
        self._init_resize()

    def _keep_proxy(self, fn: Callable[..., Any]) -> Any:
        p = create_proxy(fn)
        self._proxies.append(p)
        return p

    def _hide_toast(self) -> None:
        if self._toast_el is not None:
            self._toast_el.classList.remove("visible")

    def show_toast(self, msg: str, ms: int = 1800) -> None:
        if self._toast_el is None:
            return
        self._toast_el.textContent = msg
        self._toast_el.classList.add("visible")
        if self._toast_timeout is not None:
            js.clearTimeout(self._toast_timeout)
        self._toast_timeout = js.setTimeout(self._keep_proxy(self._hide_toast), ms)

    def _sync_js_state_from_store(self) -> None:
        for k, v in self._store.state.items():
            setattr(self._js_state, k, v)

    def _bind(self, folder: Any, key: str, label: str, *args: Any) -> Any:
        js_args = [to_js_obj(a) if isinstance(a, dict) else a for a in args]
        ctrl = folder.add(self._js_state, key, *js_args).name(label)

        def on_change(v: Any) -> None:
            self._store.set(key, v)
            self.show_toast(f"Updated: {key}")

        return ctrl.onChange(self._keep_proxy(on_change))

    def _init_gui(self) -> None:
        self._gui = self._GUI.new(to_js_obj({"title": "SIMULATION ENGINE CONFIG", "width": 320}))

        f_hud = self._gui.addFolder("Tactical HUD & Visualizers")
        self._bind(f_hud, "showPotentialField", "Potential Field Matrix")
        self._bind(f_hud, "showEscapeAperture", "Escape Aperture Cone")
        self._bind(f_hud, "showThreatVectors", "Bullet Ingress Rays")
        self._bind(f_hud, "showVelocityVectors", "Kinematic Velocity Vectors")
        self._bind(f_hud, "showTacticalAnchors", "Cover Anchor Nodes")
        self._bind(f_hud, "showDVOCandidates", "DVO Velocity Search Rays")
        self._bind(f_hud, "showBallisticLead", "Ballistic Intercept Trajectory")
        self._bind(f_hud, "showTargetAnalysis", "Target Scoring & Brackets")
        self._bind(f_hud, "showEnclosureSectors", "Enclosure & Pinch Wedges")
        self._bind(f_hud, "showPerimeterRings", "Tactical Range Perimeters")
        self._bind(f_hud, "showDiagnosticsHUD", "Telemetry & Diagnostics HUD")

        f_brain = self._gui.addFolder("Tactical Brain & DVO Tuning")
        self._bind(
            f_brain,
            "leadSolverMode",
            "Ballistic Lead Solution",
            {
                "4th-Order Polynomial": LeadSolverMode.NEWTON_RAPHSON_CTRA.value,
                "2nd-Order Linear": LeadSolverMode.QUADRATIC_CONSTANT_VELOCITY.value,
                "Direct (No Lead)": LeadSolverMode.DIRECT_AIM_NO_LEAD.value,
            },
        )
        self._bind(f_brain, "dvoSampleCount", "DVO Ray Density", 8, 360, 4)
        self._bind(f_brain, "dvoTimeHorizon", "DVO Lookahead Horizon (s)", 0.1, 8.0, 0.1)
        self._bind(f_brain, "dvoSafetyRadius", "Collision Safety Margin (px)", 2, 120, 1)
        self._bind(f_brain, "dvoEmergencyThreshold", "Emergency Juke TTC (s)", 0.02, 2.5, 0.02)
        self._bind(f_brain, "potentialFieldWeight", "Potential Repulsion Bias", 0, 8.0, 0.05)
        self._bind(f_brain, "targetCommitDuration", "Target Lock Hysteresis (s)", 0, 5.0, 0.05)
        self._bind(f_brain, "kitingDistance", "Optimal Stand-off Stance (px)", 40, 900, 10)
        self._bind(f_brain, "anchorSampleResolution", "Cover Anchor Density", 6, 120, 2)
        self._bind(f_brain, "breakoutAggression", "Breakout Aggression", 0.1, 10.0, 0.1)

        f_hero = self._gui.addFolder("Hero AI & Dynamic Specs")
        self._bind(f_hero, "heroSpeed", "Base Speed (px/s)", 50, 2000, 10)
        self._bind(f_hero, "heroFireRate", "Fire Rate (Hz)", 0.1, 100, 0.2)
        self._bind(f_hero, "heroHealth", "Max Health (HP)", 10, 10000, 10)
        self._bind(f_hero, "heroRegenRate", "Shield Regen (HP/s)", 0, 500, 1)
        self._bind(f_hero, "heroBulletSpeed", "Bullet Velocity (px/s)", 100, 5000, 25)
        self._bind(f_hero, "heroDamage", "Bullet Damage", 1, 2000, 1)
        self._bind(f_hero, "dodgeForce", "Kinematic Thrust (Juke)", 50, 5000, 25)

        f_swarm = self._gui.addFolder("Hostile Swarm Intelligence")
        self._bind(f_swarm, "startWave", "Jump to Wave", 1, 500, 1)
        self._bind(f_swarm, "swarmMultiplier", "Swarm Density Multiplier", 0.1, 10.0, 0.1)
        self._bind(f_swarm, "enemySpeed", "Hostile Speed (px/s)", 30, 1500, 10)
        self._bind(f_swarm, "enemyFireRate", "Hostile Fire Rate (Hz)", 0.05, 50, 0.1)
        self._bind(f_swarm, "enemyHealth", "Hostile Base Health", 5, 5000, 5)
        self._bind(f_swarm, "enemyDamage", "Hostile Bullet Damage", 1, 1000, 1)

        f_arena = self._gui.addFolder("Arena & Environment Engine")
        self._bind(
            f_arena,
            "arenaLayout",
            "Arena Architecture",
            {
                "Dynamic Procedural": ArenaLayout.DYNAMIC.value,
                "Hexagonal Pillars": ArenaLayout.PILLARS.value,
                "Corridor Bunkers": ArenaLayout.BUNKERS.value,
                "Cross Fortress": ArenaLayout.FORTRESS.value,
                "Open Battleground": ArenaLayout.OPEN.value,
            },
        )
        self._bind(f_arena, "timeScale", "Time Dilator", 0.01, 10.0, 0.05)

        def pause_resume() -> None:
            paused = self._sim.toggle_pause()
            self.show_toast("Simulation Paused" if paused else "Simulation Resumed")

        def step_frame() -> None:
            self._sim.step_once(1.0 / 60.0)
            self.show_toast("Stepped 1 Frame")

        def jump_wave() -> None:
            w = int(self._store.get("startWave") or 1)
            self._sim.jump_to_wave(w)
            self.show_toast(f"Jumped to Wave {w}")

        def restart_wave() -> None:
            self._sim.reset_simulation()
            self.show_toast("Simulation Restarted")

        async def _export_clipboard(json_str: str) -> None:
            try:
                await js.navigator.clipboard.writeText(json_str)
                self.show_toast("Config JSON copied to clipboard!")
            except Exception:
                js.prompt("Copy Configuration JSON:", json_str)

        def export_json() -> None:
            json_str = self._store.export_json()
            asyncio.ensure_future(_export_clipboard(json_str))

        def import_json() -> None:
            raw = js.prompt("Paste Configuration JSON:")
            if raw and self._store.import_json(str(raw)):
                self._sync_js_state_from_store()
                for c in self._gui.controllersRecursive():
                    c.updateDisplay()
                self.show_toast("Config imported successfully!")
            elif raw:
                self.show_toast("Failed to parse JSON.")

        def reset_defaults() -> None:
            self._store.reset_defaults()
            self._sync_js_state_from_store()
            for c in self._gui.controllersRecursive():
                c.updateDisplay()
            self._sim.reset_simulation()
            self.show_toast("Reset to Defaults")

        js_actions = js.Object.new()
        setattr(js_actions, "pauseResume", self._keep_proxy(pause_resume))
        setattr(js_actions, "stepFrame", self._keep_proxy(step_frame))
        setattr(js_actions, "jumpWave", self._keep_proxy(jump_wave))
        setattr(js_actions, "restartWave", self._keep_proxy(restart_wave))
        setattr(js_actions, "exportJSON", self._keep_proxy(export_json))
        setattr(js_actions, "importJSON", self._keep_proxy(import_json))
        setattr(js_actions, "resetDefaults", self._keep_proxy(reset_defaults))

        f_actions = self._gui.addFolder("Simulation Controls")
        f_actions.add(js_actions, "pauseResume").name("Pause / Resume")
        f_actions.add(js_actions, "stepFrame").name("Step Frame")
        f_actions.add(js_actions, "jumpWave").name("Jump Wave")
        f_actions.add(js_actions, "restartWave").name("Restart Wave")
        f_actions.add(js_actions, "exportJSON").name("Export JSON")
        f_actions.add(js_actions, "importJSON").name("Import JSON")
        f_actions.add(js_actions, "resetDefaults").name("Reset Default Config")

    def _init_resize(self) -> None:
        if self._container is None or self._canvas is None:
            return

        def resize(*_args: Any) -> None:
            dpr = float(getattr(js.window, "devicePixelRatio", 1.0) or 1.0)
            rect = self._container.getBoundingClientRect()
            w = max(300.0, float(rect.width))
            h = max(200.0, float(rect.height))
            self._canvas.width = int(math.floor(w * dpr))
            self._canvas.height = int(math.floor(h * dpr))
            self._ctx.setTransform(dpr, 0.0, 0.0, dpr, 0.0, 0.0)

        self._resize_observer = js.ResizeObserver.new(self._keep_proxy(resize))
        self._resize_observer.observe(self._container)
        resize()
# endregion


# region 4.3: RuntimeMainLoop
async def main() -> None:
    resources = await bootstrap_and_resource_injection()
    GUI = resources["GUI"]
    container = resources["container"]
    canvas = resources["canvas"]
    ctx = resources["ctx"]
    toast_el = resources["toast_el"]

    ARENA_WIDTH = 1200.0
    ARENA_HEIGHT = 800.0
    ARENA_PADDING = 24.0

    config_store = ConfigStore(CONFIG_SCHEMA)
    sim = Simulation(config_store, ARENA_WIDTH, ARENA_HEIGHT)
    _ui = UIManager(
        GUI=GUI,
        sim=sim,
        store=config_store,
        container=container,
        canvas=canvas,
        ctx=ctx,
        toast_el=toast_el,
    )

    last_time = float(js.performance.now())
    loop_proxy: Optional[Any] = None

    def loop(current_time: float) -> None:
        nonlocal last_time
        dt = min((float(current_time) - last_time) / 1000.0, 0.033)
        last_time = float(current_time)
        sim.update(dt)
        dpr = float(getattr(js.window, "devicePixelRatio", 1.0) or 1.0)
        CanvasRenderer.render(
            ctx,
            sim.state,
            float(canvas.width) / dpr,
            float(canvas.height) / dpr,
            ARENA_WIDTH,
            ARENA_HEIGHT,
            ARENA_PADDING,
            sim.config,
        )
        js.requestAnimationFrame(loop_proxy)

    loop_proxy = create_proxy(loop)
    js.requestAnimationFrame(loop_proxy)


asyncio.ensure_future(main())
# endregion
# endregion