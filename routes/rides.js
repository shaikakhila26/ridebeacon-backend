// routes/rides.js (updated)
import express from "express";
import supabase from "../lib/supabase.js";
import stripe from "../lib/stripe.js";
import PDFDocument from 'pdfkit';
import path from "path";
import { fileURLToPath } from 'url';


const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const BASE_FARE = 25; // Rs
const RATE_PER_KM = 12; // Rs per km
const RIDE_TYPE_MULTIPLIERS = {
  Standard: 1,
  Premium: 1.5,
  XL: 2,
};

function calculateFare(distanceKm, rideType = "Standard") {
  const multiplier = RIDE_TYPE_MULTIPLIERS[rideType] || 1;
  return (BASE_FARE + RATE_PER_KM * distanceKm) * multiplier;
}
// Create ride request
router.post("/", async (req, res) => {
  try {
    const { rider_id, pickup, dropoff, ride_type, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng } = req.body;

    const distance = getDistanceFromLatLonInKm(pickup_lat,pickup_lng,dropoff_lat,dropoff_lng);
    const fare= calculateFare(distance,ride_type);

    const { data, error } = await supabase
      .from("rides")
      .insert([{
        rider_id,
        pickup,
        dropoff,
        fare,
        ride_type: ride_type || 'Standard',
        status: "pending",
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng
      }])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Emit to drivers (all clients). Driver clients should filter by proximity.
    const io = req.app.get("io");
    if (io) io.emit("new_ride_request", data);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get rides for a rider
router.get("/user/:rider_id", async (req, res) => {
  const { rider_id } = req.params;
  const { data, error } = await supabase.from("rides").select("*").eq("rider_id", rider_id);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/drivers/:id/location
// Optional body: { lat, lng, ride_id }
router.post("/drivers/:id/location", async (req, res) => {
  const { id } = req.params;
  const { lat, lng, ride_id } = req.body;

  if (lat == null || lng == null) return res.status(400).json({ error: "Coordinates required" });

  try {
    const { data, error } = await supabase
      .from("users")
      .update({ lat, lng, updated_at: new Date() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;

    // If ride_id provided, notify riders in that ride room
    const io = req.app.get("io");
    if (io && ride_id) {
      io.to(`ride_${ride_id}`).emit("driver_location_update", { rideId: ride_id, driverId: id, lat, lng });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get nearby rides
router.get("/nearby", async (req, res) => {
  const { driver_lat, driver_lng,driver_id, radius_km = 5 } = req.query;
  const lat = parseFloat(driver_lat);
  const lng = parseFloat(driver_lng);
  if (isNaN(lat) || isNaN(lng)) return res.json([]);

  try {
   let query = supabase
  .from("rides")
  .select("*")
  .is("driver_id", null)
  .eq("status", "pending");

if (driver_id) {
  query = query.not("declined_by", "cs", `{${driver_id}}`);
}

const { data, error } = await query;

    if (error) throw error;

    const nearby = data
      .map((ride) => {
        if (!ride.pickup_lat || !ride.pickup_lng) return null;
        const distance = getDistanceFromLatLonInKm(lat, lng, ride.pickup_lat, ride.pickup_lng);
        return { ...ride, distance };
      })
      .filter((r) => r && r.distance <= radius_km)
      .sort((a, b) => a.distance - b.distance);

    res.json(nearby);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Haversine helpers
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = deg2rad(lat2-lat1);
  const dLon = deg2rad(lon2-lon1);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
function deg2rad(deg) { return deg * (Math.PI/180) }

// 2. Accept a ride
router.post("/:id/accept", async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) return res.status(400).json({ error: "No driver_id provided" });

    const rideId = req.params.id;

    const { data, error } = await supabase
      .from("rides")
      .update({ driver_id, status: "confirmed" })
      .eq("id", rideId)
      .is("driver_id", null) // only accept if none assigned
      .select()
      .single();

    if (error) throw error;

    // Fetch driver profile to include in response
    const { data: driverData, error: drvErr } = await supabase
      .from("users")
      .select("id, full_name, phone, profile_pic, vehicle, vehicle_plate")
      .eq("id", driver_id)
      .single();

    // Emit to the ride room that ride has been confirmed and driver assigned
    const io = req.app.get("io");
    if (io) {
      io.to(`ride_${rideId}`).emit("ride_status_update", { rideId, status: "confirmed" });
      io.to(`ride_${rideId}`).emit("driver_assigned", { rideId, driver: driverData || null });
    }

    // return ride + driver
    res.json({ ...data, driver: driverData || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Update ride status (in_progress / completed)
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    let dbStatus;
    switch (status) {
      case "in_progress": dbStatus = "ongoing"; break;
      case "completed": dbStatus = "completed"; break;
      default: dbStatus = status;
    }
    const rideId = req.params.id;

    const { data, error } = await supabase
      .from("rides")
      .update({ status: dbStatus })
      .eq("id", rideId)
      .select()
      .single();

    if (error) throw error;

    const io = req.app.get("io");
    if (io) {
      io.to(`ride_${rideId}`).emit("ride_status_update", { rideId, status: dbStatus });
      if (dbStatus === "completed") {
        io.to(`ride_${rideId}`).emit("ride_completed", { rideId });
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a ride (PATCH /api/rides/:id/cancel)
router.patch("/:id/cancel", async (req, res) => {
  try {
    const rideId = req.params.id;

    // Update ride status to cancelled
    const { data, error } = await supabase
      .from("rides")
      .update({ status: "cancelled" })
      .eq("id", rideId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Emit cancelation event to ride room for real-time update
    const io = req.app.get("io");
    if (io) {
      io.to(`ride_${rideId}`).emit("ride_status_update", { rideId, status: "cancelled" });
      io.to(`ride_${rideId}`).emit("ride_cancelled", { rideId });  // optional extra event
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/complete after payment confirmed
router.patch("/:id/complete", async (req, res) => {
  const rideId = req.params.id;

  // Check if payment completed for this ride
  const { data: payment, error: payError } = await supabase.from("payments")
    .select("*")
    .eq("ride_id", rideId)
    .eq("status", "completed")
    .single();

  if (payError || !payment) {
    return res.status(400).json({ error: "Payment not completed for this ride." });
  }

  // Mark ride as completed
  const { data, error } = await supabase.from("rides")
    .update({ status: "completed" })
    .eq("id", rideId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});


// Decline a ride (PATCH /api/rides/:id/decline)
router.patch("/:id/decline", async (req, res) => {
  try {
    const {driver_id} = req.body;
    const rideId = req.params.id;

    // Mark as declined (or back to pending so another driver can pick it)
const { data: ride } = await supabase
  .from("rides")
  .select("declined_by")
  .eq("id", rideId)
  .single();

const declinedBy = ride.declined_by || [];
if (!declinedBy.includes(driver_id)) declinedBy.push(driver_id);

const { data, error } = await supabase
  .from("rides")
  .update({ declined_by: declinedBy })
  .eq("id", rideId)
  .select()
  .single();


    if (error) return res.status(400).json({ error: error.message });

    const io = req.app.get("io");
    if (io) {
      io.to(`ride_${rideId}`).emit("ride_status_update", { rideId, status: "pending" });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Mark ride payment status completed after rider payment
router.patch("/:id/mark-paid", async (req, res) => {
  const rideId = req.params.id;

  try {
    const { data, error } = await supabase
      .from("rides")
      .update({ payment_status: "completed" })
      .eq("id", rideId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
   
    // After updating payment_status:
const io = req.app.get("io");
if (io) {
  io.to(`ride_${rideId}`).emit("ride_updated", data); // 'data' is the updated ride
}

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rides/history?userId=xxx&role=rider|driver
router.get('/history', async (req, res) => {
  const { userId, role } = req.query;
  if (!userId || !role || !['rider', 'driver'].includes(role)) {
    return res.status(400).json({ error: 'userId and valid role (rider or driver) required' });
  }

  try {
    let query = supabase
      .from('rides')
      .select(`
        id, pickup, dropoff, fare, status, payment_status, ride_type, created_at,
        rider:users!rides_rider_id_fkey(id, full_name),
        driver:users!rides_driver_id_fkey(id, full_name)
      `)
      .order('created_at', { ascending: false })
      .limit(100);
    
    if (role === 'rider') query = query.eq('rider_id', userId);
    else query = query.eq('driver_id', userId);

    const { data, error } = await query;
    if (error) throw error;

    return res.json(data);
  } catch (error) {
    console.error('Error fetching ride history:', error);
    return res.status(500).json({ error: 'Failed to fetch ride history' });
  }
});

router.get('/:rideId/receipt', async (req, res) => {
    console.log('receipt request for rideId :',req.params.rideId);
    const { rideId } = req.params;


 try {
 const { data: ride, error } = await supabase
 .from('rides')
 .select(`
 id, pickup, dropoff, fare, status, payment_status, ride_type, created_at,
 rider:users!rides_rider_id_fkey(id, full_name,phone),
 driver:users!rides_driver_id_fkey(id, full_name, phone),
 payments:payments!payments_ride_id_fkey(amount, status, payment_method, created_at)
 `)
 .eq('id', rideId)
 .single();


 console.log('DB query error:', error);
 console.log('Ride data:', ride);


 if (error || !ride) return res.status(404).send('Ride not found');


 // Fetch rider email from Supabase Auth separately
        const { data: riderAuth, error: riderAuthError } = await supabase.auth.admin.getUserById(ride.rider?.id);
         const riderEmail = riderAuthError ? null : riderAuth?.user?.email || null;


 // Fetch driver email from Supabase Auth separately
 const { data: driverAuth, error: driverAuthError } = ride.driver ? await supabase.auth.admin.getUserById(ride.driver.id) : { data: null, error: null };
 const driverEmail = driverAuthError ? null : (driverAuth?.user?.email || null);

 // Start PDF generation

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=RideReceipt_${rideId}.pdf`,
        'Content-Length': pdfData.length
      });
      res.end(pdfData);
    });

   // HEADER BAR with LOGO (logo left, title right)
  doc.rect(0, 0, doc.page.width, 55).fill('#fed600');
  const logoPath = path.join(__dirname, '..', 'public', 'logo1.png');
  doc.image(logoPath, 40, 10, { width: 50 });
  doc.font('Helvetica-Bold').fontSize(17).fillColor("#181818")
     .text('Ride Receipt', doc.page.width - 160, 22, { width: 120, align: 'right' });

  // Trip & Fare Block
  doc.y = 70;
  const leftMargin = 40;
  const infoTopY = doc.y;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#181818')
      .text(`${ride.pickup} to ${ride.dropoff}`, leftMargin, doc.y);
  doc.moveDown(1);
  doc.font('Helvetica').fontSize(10).fillColor('#555')
      .text(`Trip ID: ${ride.id}`, leftMargin)
  
      doc.text(`Date: ${new Date(ride.created_at).toLocaleString()}`, leftMargin, infoTopY + 35, { width: doc.page.width - 2 * leftMargin, align: 'right' });
  doc.moveDown(2);
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#fed600')
      .text(`Total Fare: ₹${ride.fare.toFixed(2)}`, leftMargin, doc.y);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#181818')
    .text(`Status: ${ride.status.charAt(0).toUpperCase() + ride.status.slice(1)}`, leftMargin)
    .text(`Payment Status: ${ride.payment_status.charAt(0).toUpperCase() + ride.payment_status.slice(1)}`, leftMargin);

  doc.moveDown(1.2);

  // Rider & Driver cards perfectly aligned
  const baseY = doc.y;
  const cardW = 210, cardH = 68, gap = 30;
  const riderX = leftMargin, driverX = leftMargin + cardW + gap;

  // Rider card (left)
  doc.roundedRect(riderX, baseY, cardW, cardH, 8).stroke('#fed600');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#181818')
      .text("Rider", riderX + 12, baseY + 8);
  doc.font('Helvetica').fontSize(10)
      .text(`Name: ${ride.rider?.full_name || 'N/A'}`, riderX + 12, baseY + 26)
      .text(`Phone: ${ride.rider?.phone || 'N/A'}`, riderX + 12, baseY + 40)
      .text(`Email: ${riderEmail}`, riderX + 12, baseY + 54);

  // Driver card (right)
  doc.roundedRect(driverX, baseY, cardW, cardH, 8).stroke('#fed600');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#181818')
      .text("Driver", driverX + 12, baseY + 8);
  doc.font('Helvetica').fontSize(10)
      .text(`Name: ${ride.driver?.full_name || 'N/A'}`, driverX + 12, baseY + 26)
      .text(`Phone: ${ride.driver?.phone || 'N/A'}`, driverX + 12, baseY + 40)
      .text(`Email: ${driverEmail}`, driverX + 12, baseY + 54);

  doc.y = baseY + cardH + 22;
  doc.moveDown(0.5);

  // Ride and payment details (left-aligned)
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#181818')
    .text("Ride Details", leftMargin, doc.y);
  doc.font('Helvetica').fontSize(11).fillColor('#222')
    .text(`Vehicle Type: ${ride.ride_type}`, leftMargin);
  doc.moveDown(0.5);

  if (ride.payments && ride.payments.length > 0) {
    const payment = ride.payments[0];
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#181818')
      .text("Payment Details", leftMargin, doc.y);
    doc.font('Helvetica').fontSize(11).fillColor('#222');
    doc.text(`Amount: ₹${payment.amount?.toFixed(2) || '-'}`, leftMargin)
       .text(`Method: ${payment.payment_method || '-'}`, leftMargin)
       .text(`Status: ${payment.status || '-'}`, leftMargin)
       .text(`Paid On: ${payment.created_at ? new Date(payment.created_at).toLocaleString() : '-'}`, leftMargin);
  }

  doc.moveDown(2);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#181818')
      .text("Thank you for riding with Ride Beacon!", { align: "center" });


    doc.end();
  } catch (err) {
    console.error('Failed to generate receipt PDF:', err);
    res.status(500).send('Error generating receipt');
  }
});


router.get('/:id', async (req, res) => {
  const rideId = req.params.id;
  try {
 
    const { data, error } = await supabase
      .from('rides')
      .select(`
        *,
        rider:users!rides_rider_id_fkey(id, full_name,phone,profile_pic),
        driver:users!rides_driver_id_fkey(id, full_name, phone,profile_pic)
      `)
      .eq('id', rideId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Ride not found' });
    // Fetch rider email from auth.users
    const { data: riderAuth, error: riderAuthError } = await supabase.auth.admin.getUserById(data.rider?.id);
    if (!riderAuthError && riderAuth?.user?.email) {
      data.rider.email = riderAuth.user.email;
    } else {
      data.rider.email = null;
    }

    // Fetch driver email from auth.users
    if (data.driver?.id) {
      const { data: driverAuth, error: driverAuthError } = await supabase.auth.admin.getUserById(data.driver.id);
      if (!driverAuthError && driverAuth?.user?.email) {
        data.driver.email = driverAuth.user.email;
      } else {
        data.driver.email = null;
      }
    }

    res.json(data);
   
  } catch (err) {
    console.error("Error in /api/rides/:id:",err);
    res.status(500).json({ error: 'Failed to fetch ride' });
  }
});




export default router;
