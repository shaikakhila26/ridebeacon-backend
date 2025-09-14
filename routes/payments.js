import express from "express";
import supabase from "../lib/supabase.js";
import stripe from "../lib/stripe.js";
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';
import {sendRideReceiptEmail} from '../utils/email.js';
import { verifySupabaseToken } from "../middlewares/authMiddleware.js";
const router = express.Router();

// Setup Supabase Storage client with service role key
const supabaseStorage = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// Create a PaymentIntent for a ride (called when rider wants to pay)
router.post("/intent",verifySupabaseToken, async (req, res) => {
  const { amount, ride_id, rider_id } = req.body;
  console.log("payment intent request:",req.body);
  if (!(amount && ride_id && rider_id)) {
    return res.status(400).json({ error: "Missing required fields amount, ride_id or rider_id" });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: "Amount must be a positive number" });
  }

  
   try {
    // Check if a payment record for this ride and rider already exists (avoid duplicates)
    let { data: existingPayment, error: fetchError } = await supabase
      .from("payments")
      .select("*")
      .eq("ride_id", ride_id)
      .eq("rider_id", rider_id)
      .eq("status", "pending")
      .limit(1)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      // PGRST116 = No rows found, which is acceptable here
      console.error("Error fetching existing payment:", fetchError);
    }

    // If no existing pending payment, create it
    if (!existingPayment) {
    // Create payment record with status "pending"
    const { data: paymentData, error: paymentError } = await supabase
      .from("payments")
      .insert([
        {
          ride_id,
          rider_id,
          amount,
          status: "pending",
          payment_method: "stripe_intent", // or null until confirmed
        },
      ])
      .select()
      .single();

    if (paymentError) {
      console.error("Error creating payment record:", paymentError);
      // Don't block; continue with PaymentIntent creation
    }
    else {
      existingPayment = paymentData;
    }
  }
    // Amount in cents (e.g. $10.00 = 1000)
    const amountInPaise = Math.round(amount*100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInPaise,
      currency: "inr",
      metadata: { ride_id, rider_id },
      automatic_payment_methods: { enabled: true },
    });

    // Optional: Update payment record with payment_intent_id
    if (existingPayment) {
      const { data, error } = await supabase
        .from("payments")
        .update({ payment_intent_id: paymentIntent.id })
        .eq("id", existingPayment.id);

      if (error) {
        console.error("Error updating payment intent id:", error);
      }
    }
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Stripe paymentIntent error:",err.message);
    res.status(400).json({ error: err.message });
  }
});

// Save payment record (optional, but helps to track pending payments)
router.post("/", verifySupabaseToken,async (req, res) => {
  const { ride_id, rider_id, amount, payment_method } = req.body;
  if(!(ride_id && rider_id && amount)) {
    return res.status(400).json({error:"Missing required fields"});
  }
  const { data, error } = await supabase
    .from("payments")
    .insert([{ ride_id, rider_id, amount, status: "pending", payment_method }])
    .select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// Stripe webhook to confirm payments
export async function webhookHandler(req, res) {
  console.log("Stripe webhook received:", req.body);
console.log("Stripe event type:", req.body.type || (req.body.data && req.body.data.object && req.body.data.object.object));

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, 
      req.headers["stripe-signature"], 
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  console.log("Received Stripe event:", event.type);

  // Payment successful => update Supabase payments
  if (event.type === "payment_intent.succeeded") {
    console.log("Processing payment_intent.succeeded for ID:", event.data.object.id);

      const paymentIntent = event.data.object;
      const rideId = paymentIntent.metadata.ride_id;
      const riderId = paymentIntent.metadata.rider_id;
      const amount = paymentIntent.amount_received / 100; // convert paise → INR

      console.log("PaymentIntent succeeded:", paymentIntent.id);

      try {
        // 1. Update ride
        await supabase
          .from("rides")
          .update({ payment_status: "completed", status: "completed" })
          .eq("id", rideId);

        // 2. Insert final payment record
        await supabase.from("payments").insert({
          ride_id: rideId,
          rider_id: riderId,
          amount,
          status: "completed",
          payment_method:
            paymentIntent.payment_method_types?.[0] || "card",
          payment_intent_id: paymentIntent.id,
        });

        // 3. Increment driver’s total earnings
        const { data: ride, error: rideFetchError } = await supabase
          .from("rides")
          .select("driver_id, fare")
          .eq("id", rideId)
          .single();

        if (rideFetchError) {
          console.error("Error fetching ride:", rideFetchError.message);
        }

        if (ride?.driver_id) {
          try{
          await supabase.rpc("increment_driver_earnings", {
            
            driver_id: ride.driver_id,
            fare: ride.fare,
          });
          console.log("Driver earnings incremented successfully");
        } catch (rpcError) {
          console.error("Error incrementing driver earnings:", rpcError);
        }
        }

        console.log("Payment + ride update completed successfully ✅");

   // 4. Fetch ride with rider info for PDF

      const { data: ridedata, error: rideError } = await supabase
  .from('rides')
  .select('*')
  .eq('id', rideId)
  .single();

if (rideError) throw rideError;

// Fetch rider info separately
const { data: rider, error: riderError } = await supabase
  .from('users')
  .select('id, full_name, phone')
  .eq('id', ridedata.rider_id)
  .single();

  if (riderError) throw riderError;

  // Fetch auth user email separately
const { data: authUser, error: authUserError } = await supabase.auth.admin.getUserById(rider.id);

if (authUserError) throw authUserError;

const riderWithEmail = {
  ...rider,
  email: authUser.user.email // or wherever the email property exists
};

const {data:driver , error:driverError} = await supabase
.from('users')
.select('id , full_name , phone')
.eq('id',ridedata.driver_id)
.single();

if(driverError) throw driverError;

const { data: authDriver, error: authDriverError } = await supabase.auth.admin.getUserById(driver.id);


if (authDriverError) throw authDriverError;


const driverWithEmail = {
 ...driver,
  email: authDriver.user.email // or wherever the email property exists
};



const fullRide = { ...ridedata, rider : riderWithEmail ,driver:driverWithEmail};

      // Generate PDF receipt and upload

      if (fullRide) {

        const pdfBuffer = await generateReceiptPdfBuffer(fullRide);



        const filePath = `${rideId}.pdf`;



        const { error: uploadError } = await supabaseStorage

          .storage

          .from('receipts')

          .upload(filePath, pdfBuffer, {

            contentType: 'application/pdf',

            upsert: true,

          });



        if (uploadError) {

          console.error('Error uploading receipt PDF:', uploadError.message);

        } else {

          const { data } = await supabaseStorage

            .storage

            .from('receipts')

            .createSignedUrl(filePath, 60 * 60 * 24); // 24 hours expiry



          if (data?.signedUrl) {
console.log("Receipt signed URL:", data.signedUrl);
try{
            await sendRideReceiptEmail(fullRide.rider.email, data.signedUrl);

            console.log(`Receipt email sent to ${fullRide.rider.email}`);
}
catch(emailError){
  console.error(`Failed to send receipt email to ${fullRide.rider.email}:`, emailError);
}
          } else {

            console.error('Failed to generate signed URL for receipt');

          }

        }

      } else {

        console.error('No ride data to generate receipt PDF');
      
      }

    } catch (err) {

      console.error("Failed to update DB or send email after payment:", err.message);

    }

  }
  res.sendStatus(200);
}


// Utility to generate PDF buffer for receipt
async function generateReceiptPdfBuffer(ride) {
  return new Promise((resolve, reject) => {
const doc = new PDFDocument({ size: 'A4', margin: 40 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      resolve(pdfData);
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
      .text(`Email: ${ride.rider.email}`, riderX + 12, baseY + 54);

  // Driver card (right)
  doc.roundedRect(driverX, baseY, cardW, cardH, 8).stroke('#fed600');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#181818')
      .text("Driver", driverX + 12, baseY + 8);
  doc.font('Helvetica').fontSize(10)
      .text(`Name: ${ride.driver?.full_name || 'N/A'}`, driverX + 12, baseY + 26)
      .text(`Phone: ${ride.driver?.phone || 'N/A'}`, driverX + 12, baseY + 40)
      

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
});
}


export default router;
