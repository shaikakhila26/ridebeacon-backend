import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import supabase from "./lib/supabase.js";

import { verifySupabaseToken } from "./middlewares/authMiddleware.js";

// Import routes
import authRoutes from "./routes/auth.js";
import rideRoutes from "./routes/rides.js";
import paymentRoutes,{webhookHandler} from "./routes/payments.js";
import geocodeRoutes from "./routes/geocode.js";
import directionsRouter from "./routes/directions.js";
import driverRoutes from "./routes/drivers.js";
import reviewsRouter from "./routes/reviews.js";

// Load environment variables
dotenv.config();

const app = express();

// Mount your webhook *before* middlewares that parse JSON
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  webhookHandler
);

// Middleware
app.use(cors());
app.use(express.json());

// Create HTTP + WebSocket server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin:[ "http://localhost:5173" , "https://ridebeacon-frontend.vercel.app" ], // frontend URL
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io); // Make io accessible in routes


// When client connects
io.on("connection", (socket) => {
  console.log("🔌 New client connected:", socket.id);

  // Driver joins their own room
  socket.on("join_driver", (driverId) => {
    socket.join(`driver_${driverId}`);
    console.log(`Driver ${driverId} joined room`);
  });

  // Rider joins their ride room
  socket.on("join_ride", (rideId) => {
    socket.join(`ride_${rideId}`);
    console.log(`Socket ${socket.id} joined ride_${rideId}`);
  });


  // Driver location updates (from driver client via socket)
  socket.on("driver_location", ({ rideId, driverId, lat, lng }) => {
    // Emit to rider(s) in that ride room so riders can see the moving car
    if (rideId) {
      io.to(`ride_${rideId}`).emit("driver_location_update", { rideId, driverId, lat, lng });
    }
    // Also emit to a driver room (optional)
    io.to(`driver_${driverId}`).emit("driver_location_ack", { lat, lng });
  });

  // Optional: if a client emits new_ride_request, forward to all drivers (or you can emit from server API)
  socket.on("new_ride_request", (ride) => {
    // broadcast to all drivers — driver clients will further filter by their location
    io.emit("new_ride_request", ride);
  });

  // Ride status updates
  socket.on("update_ride_status", ({ rideId, status }) => {
    io.to(`ride_${rideId}`).emit("ride_status_update", { rideId, status });
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

// API Routes
app.use("/api/auth",  verifySupabaseToken,authRoutes);
app.use("/api/rides", verifySupabaseToken, rideRoutes);
app.use("/api/payments" , verifySupabaseToken,paymentRoutes);

app.use("/api/geocode", geocodeRoutes);
app.use("/api/directions",directionsRouter);

app.use("/api/drivers" , verifySupabaseToken,driverRoutes);
app.use("/api/reviews" , verifySupabaseToken, reviewsRouter);

// Health check route (good for testing)
app.get("/", (req, res) => {
  res.send("RideBeacon backend is running 🚖");
});



server.listen(5000, () => console.log("Running on http://localhost:5000"));

