"""
Flight Planner backend (Flask)

Endpoints:
  POST /check-work-area       — upload work area GeoJSON + optional GeoTIFF
  GET  /geotiff-status/<id>   — poll GeoTIFF tiling job status
  POST /default-orientation   — compute best orientation for a polygon
  POST /generate-plan         — generate lawnmower flight path
  POST /export-kmz            — export plan(s) as KMZ
  POST /import-kmz            — import KMZ as flight plan(s)
"""

from flask import Flask, request, jsonify, send_from_directory
import os

app = Flask(__name__, static_folder="static")

# ── Serve the frontend ──────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)

# ── API endpoints ───────────────────────────────────────────────────────────

@app.route("/check-work-area", methods=["POST"])
def check_work_area():
    """
    Accepts multipart form:
      work_area  — GeoJSON file
      geotiff    — optional GeoTIFF file

    Returns JSON:
      {
        work_area_geojson: <GeoJSON Feature>,
        geotiff_present: bool,
        geotiff_id: str | null
      }
    """
    # TODO: implement
    return jsonify({"error": "Not implemented"}), 501


@app.route("/geotiff-status/<job_id>", methods=["GET"])
def geotiff_status(job_id):
    """
    Returns JSON:
      { status: "pending"|"complete"|"error", message: str,
        geotiff_tile_url_template: str | null, error: str | null }
    """
    # TODO: implement
    return jsonify({"error": "Not implemented"}), 501


@app.route("/default-orientation", methods=["POST"])
def default_orientation():
    """
    Body JSON: { flight_extent: <GeoJSON geometry> }
    Returns:   { orientation_deg: float }
    """
    # TODO: implement
    return jsonify({"error": "Not implemented"}), 501


@app.route("/generate-plan", methods=["POST"])
def generate_plan():
    """
    Body JSON:
      {
        flight_extent:   <GeoJSON geometry>,
        spacing_m:       float,
        orientation_deg: float,
        shift_m:         float,
        work_area:       <GeoJSON geometry> | null
      }
    Returns JSON:
      {
        plan_geojson:       <GeoJSON Feature (LineString or MultiLineString)>,
        coverage_geojson:   <GeoJSON Feature | null>,
        missing_geojson:    <GeoJSON Feature | null>,
        coverage_fraction:  float,
        coverage_area_m2:   float,
        missing_area_m2:    float
      }
    """
    # TODO: implement
    return jsonify({"error": "Not implemented"}), 501


@app.route("/export-kmz", methods=["POST"])
def export_kmz():
    """
    Body JSON: { plans: [ { name: str, plan_geojson: <GeoJSON Feature> } ] }
    Returns:   KMZ binary (application/vnd.google-earth.kmz)
    """
    # TODO: implement
    return jsonify({"error": "Not implemented"}), 501


@app.route("/import-kmz", methods=["POST"])
def import_kmz():
    """
    Accepts multipart form: file — KMZ file
    Returns JSON:
      {
        plans: [
          { name: str, extent_geojson: <GeoJSON Feature>, plan_geojson: <GeoJSON Feature> }
        ]
      }
    """
    # TODO: implement
    return jsonify({"error": "Not implemented"}), 501


if __name__ == "__main__":
    app.run(debug=True, port=5000)
