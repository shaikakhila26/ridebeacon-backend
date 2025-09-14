// routes/directions.js
import express from "express";
import axios from "axios";

const router = express.Router();

router.get("/", async (req, res) => {
  const { origin, destination } = req.query;
  if (!origin || !destination) {
    return res.status(400).json({ error: "Missing origin or destination" });
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&mode=driving&traffic_model=best_guess&departure_time=now&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const { data } = await axios.get(url);

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({ error: "No route found" });
    }

    const route = data.routes[0];

    // Merge all step polylines for a smoother path
    const allPoints = [];
    route.legs.forEach((leg) => {
      leg.steps.forEach((step) => {
        if (step.polyline?.points) {
          allPoints.push(step.polyline.points);
        }
      });
    });

    res.json({
      polyline: route.overview_polyline.points,
      steps: allPoints, // send step polylines too
    });
  } catch (err) {
    console.error("Directions API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch directions" });
  }
});

export default router;
