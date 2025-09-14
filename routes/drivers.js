import express from "express";
import supabase from "../lib/supabase.js";
import stripe from "../lib/stripe.js";

const router = express.Router();

// 1. Create Stripe Express account for driver onboarding
router.post("/:id/connect-stripe", async (req, res) => {
  const driver_id = req.params.id;
  try {
    // Check if driver already has stripe_account_id
    const { data: driver } = await supabase
      .from("users")
      .select("stripe_account_id")
      .eq("id", driver_id)
      .single();

    if (driver?.stripe_account_id) {
      // Already connected
      return res.json({ url: null, message: "Already connected" });
    }

    const account = await stripe.accounts.create({ 
        type: "express" ,
        country:"IN",
        capabilities:{
            transfers:{requested :true},
            card_payments:{requested:true},
        },
    });

    await supabase
      .from("users")
      .update({ stripe_account_id: account.id })
      .eq("id", driver_id);

      const refreshUrl = `${process.env.FRONTEND_URL}/driver/stripe/failed`;
const returnUrl = `${process.env.FRONTEND_URL}/driver/stripe/success`;

const link = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: refreshUrl,
  return_url: returnUrl,
  type: "account_onboarding",
});

    

    res.json({ url: link.url });
  } catch (err) {
    console.error("stripe connect error:",err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Request payout transfer to driver’s connected Stripe account
router.post("/:id/payout", async (req, res) => {
  const driver_id = req.params.id;
  let { amount } = req.body;

  // Log the raw incoming request
  console.log("🔔 Payout request received:");
  console.log("Driver ID:", driver_id);
  console.log("Request body:", req.body);

  //validate amount before doing anything else
    if (!amount || isNaN(amount) || amount <=0){
        console.warn("invalid amount in payout request :",amount);
        return res.status(400).json({error:"Invalid amount"});
    }

    //convert amount to paise (integer)
    const payoutAmount = Math.floor(amount*100);
  try {

    const { data: driver } = await supabase
      .from("users")
      .select("stripe_account_id")
      .eq("id", driver_id)
      .single();

     
      console.log("✅ Driver record fetched:", driver);

    if (!driver?.stripe_account_id) {
        console.warn("no stripe account connected for driver:", driver_id);
      return res.status(400).json({ error: "Driver Stripe account not connected" });
    }

    console.log("creating stripe transfer:",{
        amount:payoutAmount,
        destination:driver.stripe_account_id,
    });

    const transfer = await stripe.transfers.create({
      amount: payoutAmount, // cents
      currency: "inr",
      destination: driver.stripe_account_id,
    });

    console.log("transfer created :" ,transfer.id);

    res.json({ message: "Payout requested successfully" , transferId: transfer.id });
  } catch (err) {
    console.error("Payout Error :",err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch total earnings for a driver
// GET /api/drivers/:id/earnings
router.get("/:id/earnings", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("users")
    .select("total_earnings")
    .eq("id", id)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.total_earnings || 0);
});


export default router;
