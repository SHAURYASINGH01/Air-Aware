"""AirAware FastAPI backend with a Strands Agents SDK tool.

The website continues to work in rules-only mode if Strands or Bedrock is not
configured. A response only reports Strands/Bedrock mode when that call succeeds.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from strands import Agent, tool
    from strands.models import BedrockModel
    STRANDS_AVAILABLE = True
    STRANDS_IMPORT_ERROR = ""
except Exception as exc:  # Planner still works without optional AI setup.
    Agent = None  # type: ignore[assignment,misc]
    BedrockModel = None  # type: ignore[assignment,misc]
    STRANDS_AVAILABLE = False
    STRANDS_IMPORT_ERROR = str(exc)

    def tool(function):  # type: ignore[no-redef]
        return function

try:
    from strands.multiagent import Swarm
    SWARM_AVAILABLE = True
    SWARM_IMPORT_ERROR = ""
except Exception as exc:
    Swarm = None  # type: ignore[assignment,misc]
    SWARM_AVAILABLE = False
    SWARM_IMPORT_ERROR = str(exc)

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"
try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    # Environment variables can also be configured by the OS, IDE, or AWS service.
    pass

DEFAULT_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-1"
DEFAULT_MODEL = os.getenv("BEDROCK_MODEL_ID", "us.amazon.nova-lite-v1:0")
WAQI_API_TOKEN = os.getenv("WAQI_API_TOKEN", "").strip()

ACTIVITY_NAMES = {
    "sports": "outdoor sports / PE",
    "assembly": "assembly / campus event",
    "commute": "walking between buildings",
    "maintenance": "outdoor maintenance",
}


def aqi_category(aqi: int) -> tuple[str, str]:
    """Return the commonly used Indian CPCB AQI band and a plain-language note."""
    if aqi <= 50:
        return "Good", "Continue checking current conditions and follow local guidance."
    if aqi <= 100:
        return "Satisfactory", "Most planning can follow normal precautions; check local guidance and individual needs."
    if aqi <= 200:
        return "Moderate", "Review conditions before strenuous outdoor activities, especially for people sensitive to air pollution."
    if aqi <= 300:
        return "Poor", "Review official guidance and consider indoor alternatives for strenuous outdoor activities."
    if aqi <= 400:
        return "Very Poor", "Prioritise official guidance and carefully review whether outdoor activities should be changed."
    return "Severe", "Check official guidance before making activity decisions; this prototype is not an alert system."


def activity_recommendations(aqi: int, activity: str) -> list[str]:
    """Rule-based, cautious planning prompts; these are not medical advice."""
    high = aqi > 200
    recommendations = {
        "sports": (
            ["Consider an indoor alternative and review official guidance.", "Tell participants where the AQI reading came from and when it was checked."]
            if high else
            ["Check current conditions before the activity starts.", "Keep an option to pause or move indoors if conditions change."]
        ),
        "assembly": (
            ["Review whether an indoor venue is appropriate under current official guidance.", "Communicate any venue or schedule change and the source of the update."]
            if high else
            ["Confirm the reading time close to the event.", "Keep an alternative venue available if conditions change."]
        ),
        "commute": (
            ["Review route and timing; follow local public-health and campus guidance.", "Share where students can check reliable current readings."]
            if high else
            ["Check a recent reading before leaving.", "Follow normal travel and campus safety procedures."]
        ),
        "maintenance": (
            ["Ask the responsible supervisor to review dusty outdoor work and site-specific controls.", "Follow workplace procedures and current official guidance."]
            if high else
            ["Use required site controls and supervision.", "Record the reading source and time in the work plan."]
        ),
    }
    result = recommendations.get(activity, recommendations["sports"])
    if aqi > 400:
        result = ["Check current CPCB/local authority guidance before proceeding.", *result]
    return result


def assessment_text(aqi: int, activity: str) -> str:
    if not 0 <= aqi <= 500:
        raise ValueError("AQI must be between 0 and 500")
    category, note = aqi_category(aqi)
    recs = activity_recommendations(aqi, activity)
    return (
        f"User-supplied AQI: {aqi}/500. Indian CPCB band: {category}. {note}\n"
        f"Selected activity: {ACTIVITY_NAMES.get(activity, ACTIVITY_NAMES['sports'])}.\n"
        + "Suggested planning prompts: " + " ".join(recs)
        + "\nNot live-verified. Not medical advice or an official alert. Verify the current reading, timestamp, source, and relevant official guidance."
    )


@tool
def assess_campus_aqi(aqi: int, activity: str) -> str:
    """Assess a user-supplied Indian AQI value and return cautious campus planning prompts.

    Args:
        aqi: A whole-number AQI value from 0 through 500 supplied by the user.
        activity: One of sports, assembly, commute, or maintenance.
    """
    if not isinstance(aqi, int) or isinstance(aqi, bool) or not 0 <= aqi <= 500:
        return "Invalid AQI. Please provide a whole number from 0 to 500."
    valid_activities = set(ACTIVITY_NAMES)
    if activity not in valid_activities:
        activity = "sports"
    return assessment_text(aqi, activity)


_SYSTEM_PROMPT = """You are AirAware, a cautious campus air-safety planning assistant.
You help a campus team interpret a user-supplied AQI value and think through activity planning.
If a numeric AQI is supplied, call assess_campus_aqi before answering. Treat its result as the source of category and safety-planning facts.
Never claim a user-entered CPCB value is independently verified. Do not invent data, sources, timestamps, health statistics, or alerts. Do not give diagnoses or medical advice. Use concise, practical language, mention that suggestions are not official advice, and recommend checking the CPCB portal and relevant local guidance for current decisions.
The web app may separately display a provider-reported WAQI station index or Open-Meteo model estimate. These are not interchangeable with the Indian CPCB National AQI. The assistant receives the manually entered CPCB value unless a future version explicitly passes a live-provider record; never claim you fetched live data unless that record is present in the prompt."""

_agent = None
_swarm = None


def get_agent():
    global _agent
    if not STRANDS_AVAILABLE:
        raise RuntimeError("Strands SDK is not installed")
    if _agent is None:
        model = BedrockModel(
            model_id=DEFAULT_MODEL,
            region_name=DEFAULT_REGION,
            temperature=0.2,
            max_tokens=650,
        )
        _agent = Agent(model=model, tools=[assess_campus_aqi], system_prompt=_SYSTEM_PROMPT)
    return _agent


def get_swarm():
    """Build a bounded Strands swarm with complementary AirAware roles.

    The swarm is optional: it requires the SDK's multi-agent module plus usable
    Amazon Bedrock access. Single-agent mode remains the faster default.
    """
    global _swarm
    if not STRANDS_AVAILABLE:
        raise RuntimeError("Strands SDK is not installed")
    if not SWARM_AVAILABLE:
        raise RuntimeError("Strands Swarm is unavailable in this SDK installation")
    if _swarm is None:
        model = BedrockModel(
            model_id=DEFAULT_MODEL,
            region_name=DEFAULT_REGION,
            temperature=0.2,
            max_tokens=650,
        )
        analyst = Agent(
            name="aqi_analyst",
            description="Checks the user-supplied AQI value and identifies the relevant Indian AQI band.",
            model=model,
            tools=[assess_campus_aqi],
            system_prompt=(
                "You are AirAware's AQI analyst. Use assess_campus_aqi for any numeric value. "
                "Never call the user's number live or verified. Once the category and evidence are clear, "
                "hand off to campus_planner using handoff_to_agent with the reading, category, activity, "
                "and disclaimer. Do not provide medical advice."
            ),
        )
        planner = Agent(
            name="campus_planner",
            description="Turns a verified-by-user reading into cautious activity-specific planning options.",
            model=model,
            tools=[assess_campus_aqi],
            system_prompt=(
                "You are AirAware's campus activity planner. Use the assessment tool if category details are missing. "
                "Suggest practical options for the chosen activity and respect local official guidance. "
                "Do not make medical claims or assert this is an alert. After drafting planning options, hand off "
                "to campus_communicator and include the source/timestamp limitation."
            ),
        )
        communicator = Agent(
            name="campus_communicator",
            description="Produces a concise final campus message and clear checklist items.",
            model=model,
            system_prompt=(
                "You are AirAware's campus communicator and final reviewer. Give a short, plain-English result with: "
                "AQI category if supplied, activity-specific options, 3 checklist items, and a clear note to verify "
                "the reading source/time. Avoid alarmist language, medical advice, and false live-data claims. "
                "You are the final agent: do not hand off further."
            ),
        )
        _swarm = Swarm(
            [analyst, planner, communicator],
            entry_point=analyst,
            max_handoffs=2,
            max_iterations=4,
            execution_timeout=45.0,
            node_timeout=20.0,
            repetitive_handoff_detection_window=3,
            repetitive_handoff_min_unique_agents=3,
        )
    return _swarm


def _text_from_agent_result(result) -> str:
    """Best-effort extraction across Strands result object versions."""
    message = getattr(result, "message", None)
    if isinstance(message, dict):
        blocks = message.get("content", [])
        texts = [block.get("text", "") for block in blocks if isinstance(block, dict) and block.get("text")]
        if texts:
            return "\n".join(texts)
    content = getattr(result, "content", None)
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("text"):
                texts.append(block["text"])
            elif getattr(block, "text", None):
                texts.append(block.text)
        if texts:
            return "\n".join(texts)
    return str(result)


def _text_from_swarm_result(result) -> str:
    """Prefer the last agent's response, with a fallback to Swarm result content."""
    content = getattr(result, "content", None)
    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict) and block.get("text"):
                texts.append(block["text"])
            elif getattr(block, "text", None):
                texts.append(block.text)
        if texts:
            return "\n".join(texts)
    results = getattr(result, "results", None)
    history = getattr(result, "node_history", None)
    if isinstance(results, dict) and results:
        final_id = None
        if history:
            final_id = getattr(history[-1], "node_id", None)
        node_result = results.get(final_id) if final_id else None
        if node_result is None:
            node_result = next(reversed(results.values()))
        nested = getattr(node_result, "result", node_result)
        return _text_from_agent_result(nested)
    return _text_from_agent_result(result)


class AskRequest(BaseModel):
    question: str = Field(default="What precautions should the campus consider?", max_length=600)
    location: str = Field(default="Delhi", max_length=80)
    aqi: Optional[int] = Field(default=None, ge=0, le=500)
    source: str = Field(default="Not selected", max_length=80)
    activity: str = Field(default="sports", max_length=30)
    mode: str = Field(default="single", max_length=20)


app = FastAPI(title="AirAware Strands Assistant", version="0.1.0")


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "AirAware API",
        "strands_sdk_imported": STRANDS_AVAILABLE,
        "swarm_available": SWARM_AVAILABLE,
        "waqi_token_configured": bool(WAQI_API_TOKEN),
        "default_region": DEFAULT_REGION,
        "default_model": DEFAULT_MODEL,
        "note": "Health check does not make a Bedrock model call or an AQI-provider call.",
    }


CITY_POINTS = {
    "Delhi": (28.6139, 77.2090),
    "Noida": (28.5355, 77.3910),
    "Gurugram": (28.4595, 77.0266),
}


def _checked_at() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _num_or_none(value):
    try:
        if value is None or value == "-":
            return None
        number = float(value)
        return number if number == number and abs(number) != float("inf") else None
    except (TypeError, ValueError):
        return None


def _fetch_open_meteo(location: str) -> dict:
    """Fetch model-derived pollutant and international-index context.

    Open-Meteo reports a grid/model estimate, not a local monitoring-station
    observation and not the Indian CPCB National AQI.
    """
    if location not in CITY_POINTS:
        raise HTTPException(status_code=400, detail="Supported demo locations are Delhi, Noida, and Gurugram.")
    latitude, longitude = CITY_POINTS[location]
    params = urlencode({
        "latitude": latitude,
        "longitude": longitude,
        "current": "pm10,pm2_5,us_aqi,european_aqi",
        "timezone": "Asia/Kolkata",
        "forecast_days": 1,
    })
    request_obj = Request(
        f"https://air-quality-api.open-meteo.com/v1/air-quality?{params}",
        headers={"Accept": "application/json", "User-Agent": "AirAware-Student-Prototype/1.0"},
    )
    try:
        with urlopen(request_obj, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise HTTPException(status_code=502, detail="Open-Meteo model context is temporarily unavailable. Retry or use the official CPCB portal for an Indian AQI reading.") from exc
    current = payload.get("current") or {}
    if not current:
        raise HTTPException(status_code=502, detail="Open-Meteo did not return current model conditions. Please retry.")
    payload.update({
        "mode": "model_estimate",
        "source_type": "model",
        "provider": "Open-Meteo Air Quality API (CAMS model data)",
        "source_url": "https://open-meteo.com/en/docs/air-quality-api",
        "requested_location": location,
        "checked_at": _checked_at(),
        "index": current.get("us_aqi"),
        "index_label": "U.S. AQI (model estimate)",
        "index_scale": "U.S. scale — not Indian CPCB NAQI",
        "notice": "Model estimate only; this is not a monitoring-station reading. U.S./European indices are not the Indian CPCB National AQI.",
    })
    return payload


def _fetch_waqi_station(location: str) -> dict:
    """Fetch the provider-reported AQI for the nearest WAQI station.

    WAQI tokens are kept on the server and never returned to the browser.
    The WAQI index must not be substituted for the Indian CPCB National AQI.
    """
    if location not in CITY_POINTS:
        raise HTTPException(status_code=400, detail="Supported demo locations are Delhi, Noida, and Gurugram.")
    if not WAQI_API_TOKEN:
        raise RuntimeError("WAQI_API_TOKEN is not configured")
    latitude, longitude = CITY_POINTS[location]
    url = f"https://api.waqi.info/feed/geo:{latitude};{longitude}/?token={quote(WAQI_API_TOKEN, safe='')}"
    request_obj = Request(url, headers={"Accept": "application/json", "User-Agent": "AirAware-Student-Prototype/1.0"})
    try:
        with urlopen(request_obj, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (URLError, HTTPError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise RuntimeError("WAQI station service could not be reached") from exc
    if payload.get("status") != "ok" or not isinstance(payload.get("data"), dict):
        # Do not return provider payloads: they can contain internal request details.
        raise RuntimeError("WAQI did not return a station reading for this location")
    data = payload["data"]
    raw_index = data.get("aqi")
    index_value = _num_or_none(raw_index)
    if index_value is None:
        raise RuntimeError("The nearest WAQI station currently has no numeric AQI")
    index = int(index_value) if index_value.is_integer() else index_value
    city = data.get("city") or {}
    time_info = data.get("time") or {}
    iaqi = data.get("iaqi") or {}

    def pollutant(key):
        item = iaqi.get(key) or {}
        return _num_or_none(item.get("v")) if isinstance(item, dict) else None

    station_url = city.get("url") or "https://waqi.info/"
    if isinstance(station_url, str) and station_url.startswith("/"):
        station_url = "https://aqicn.org" + station_url
    attributions = []
    for item in data.get("attributions") or []:
        if isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            href = str(item.get("url") or "").strip()
            if name:
                attributions.append({"name": name, "url": href})
    return {
        "mode": "station",
        "source_type": "monitoring_station",
        "provider": "World Air Quality Index (WAQI)",
        "source_url": "https://aqicn.org/api/",
        "station_url": station_url,
        "requested_location": location,
        "station": city.get("name") or f"Nearest station to {location}",
        "coordinates": city.get("geo"),
        "index": index,
        "index_label": "Station-reported AQI",
        "index_scale": "WAQI provider index — not Indian CPCB NAQI",
        "timestamp": time_info.get("iso") or time_info.get("s") or None,
        "checked_at": _checked_at(),
        "dominant_pollutant": data.get("dominentpol") or data.get("dominantpol") or "Not reported",
        "pollutants": {
            "pm25": pollutant("pm25"),
            "pm10": pollutant("pm10"),
            "o3": pollutant("o3"),
            "no2": pollutant("no2"),
            "so2": pollutant("so2"),
            "co": pollutant("co"),
        },
        "attributions": attributions,
        "notice": "Provider-reported station index. WAQI's index methodology is not the Indian CPCB National AQI; do not enter this number into the Indian CPCB planner. Verify the official CPCB reading before campus decisions.",
    }


@app.get("/api/air-quality")
def air_quality_context(location: str = "Delhi"):
    """Backward-compatible Open-Meteo model context endpoint."""
    return _fetch_open_meteo(location)


@app.get("/api/live-aqi")
def live_aqi(location: str = "Delhi"):
    """Return station-reported WAQI AQI when configured, otherwise model estimates.

    This endpoint does not cache WAQI content; the browser refresh interval is
    15 minutes and the provider's own measurement timestamp is always shown.
    """
    if location not in CITY_POINTS:
        raise HTTPException(status_code=400, detail="Supported demo locations are Delhi, Noida, and Gurugram.")
    if WAQI_API_TOKEN:
        try:
            return _fetch_waqi_station(location)
        except HTTPException:
            raise
        except Exception:
            # Keep the screen useful, but disclose the fallback instead of hiding it.
            try:
                model = _fetch_open_meteo(location)
            except HTTPException as exc:
                raise HTTPException(status_code=502, detail="The station feed and model fallback are unavailable. Please retry or consult CPCB.") from exc
            model["notice"] = "WAQI station feed was unavailable or had no numeric reading, so this is a model estimate—not a station reading. Check the WAQI token/coverage and verify CPCB for Indian NAQI."
            model["station_feed_error"] = True
            return model
    model = _fetch_open_meteo(location)
    model["notice"] = "WAQI_API_TOKEN is not configured, so this is an Open-Meteo model estimate, not a monitoring-station AQI. Add your own WAQI token to the server environment to enable station-reported AQI."
    return model


@app.post("/api/ask")
def ask(request: AskRequest):
    activity = request.activity if request.activity in ACTIVITY_NAMES else "sports"
    question = request.question.strip() or "What precautions should the campus consider?"
    aqi_context = str(request.aqi) if request.aqi is not None else "NOT PROVIDED"
    prompt = (
        f"Campus location label: {request.location}.\n"
        f"User-supplied AQI value: {aqi_context}.\n"
        f"Selected source label: {request.source} (the app has not independently verified this source or timestamp).\n"
        f"Selected activity: {activity} ({ACTIVITY_NAMES[activity]}).\n"
        f"Question: {question}\n\n"
        "Answer in simple English. If AQI is provided, use the assessment tool. Do not call it current/live."
    )
    try:
        selected_mode = request.mode if request.mode in {"single", "swarm"} else "single"
        if selected_mode == "swarm":
            swarm = get_swarm()
            result = swarm(prompt)
            answer = _text_from_swarm_result(result)
            return {
                "answer": answer,
                "mode": "Strands multi-agent swarm + Amazon Bedrock",
                "ai_used": True,
                "agent_pattern": "swarm",
                "agent_history": [getattr(node, "node_id", "agent") for node in (getattr(result, "node_history", None) or [])],
            }
        agent = get_agent()
        result = agent(prompt)
        answer = _text_from_agent_result(result)
        return {"answer": answer, "mode": "Strands single agent + Amazon Bedrock", "ai_used": True, "agent_pattern": "single"}
    except Exception as exc:
        # Fail closed to a transparent deterministic answer; never claim AI ran.
        if request.aqi is None:
            answer = (
                "No AQI value was provided, so I cannot assess this campus activity yet. "
                "Check a trusted source such as the CPCB portal, confirm the reading time, "
                "then enter the value. This fallback response did not use an AI model."
            )
        else:
            answer = assessment_text(request.aqi, activity)
            answer += "\n\nAssistant mode: rules-based fallback; the Strands/Bedrock call was unavailable."
        return {
            "answer": answer,
            "mode": "Rules-based fallback (AI unavailable)",
            "ai_used": False,
            "hint": "Check the workshop setup, selected AWS region, Bedrock model access, and temporary credentials. For swarm mode, verify that the installed Strands SDK supports Swarm. Never paste credentials into the app, screenshots, GitHub, or chat.",
            "agent_pattern": request.mode if request.mode in {"single", "swarm"} else "single",
        }


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


# Keep these routes explicit so static files are served on the same origin as the API.
@app.get("/style.css")
def stylesheet():
    return FileResponse(FRONTEND_DIR / "style.css", media_type="text/css")


@app.get("/script.js")
def javascript():
    return FileResponse(FRONTEND_DIR / "script.js", media_type="application/javascript")
