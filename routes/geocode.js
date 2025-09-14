import express from "express";
import axios from "axios";
import dotenv from "dotenv";
const router = express.Router();

router.get("/", async (req, res) => {
  console.log("Geocode query received:", req.query);

  const { address } = req.query;
  if (!address) {
    console.log("No address provided");
    return res.status(400).json({ error: "No address provided" });
  }

  try {
    const response = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: {
          address,
          key: process.env.GOOGLE_MAPS_API_KEY, // Make sure key is in .env
          region: "in", // Bias results to India to improve accuracy
          // components: "country:IN", // optionally restrict further if needed
        },
      }
    );

    console.log("Full Geocode API response:", JSON.stringify(response.data, null, 2));

    if (response.data.status !== "OK") {
      console.log("Geocode API returned status:", response.data.status);
      return res.status(400).json({ error: response.data.status });
    }

    if (!response.data.results || response.data.results.length === 0) {
      console.log("Geocode API returned no results");
      return res.status(404).json({ error: "No geocode results found" });
    }

    const location = response.data.results[0].geometry.location;
    console.log(`Using first geocode result location for address "${address}":`, location);

    res.json({ lat: location.lat, lng: location.lng }); // simplified response

  } catch (err) {
    console.error("Geocode API request failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
