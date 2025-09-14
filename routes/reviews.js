import express from "express";
import  supabase  from "../lib/supabase.js";
const router = express.Router();


  // your review submission code here
  // POST /api/reviews
router.post('/', async (req, res) => {
  const { ride_id, driver_id, rider_id, rating, review } = req.body;

  if (!ride_id || !driver_id || !rider_id || !rating) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    // Insert or update to avoid duplicates (upsert)
    const { data, error } = await supabase
  .from('ride_reviews')
  .upsert({ ride_id, driver_id, rider_id, rating, review }, { onConflict: ['ride_id', 'rider_id'] })
  
  .select()
  .single();



    if (error) {
        console.error("supabase upsert error:",error);
        return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit review' });
  }
});




  // your fetch reviews code here
  // GET /api/drivers/:id/reviews
router.get('/drivers/:id/reviews', async (req, res) => {
  const driver_id = req.params.id;

  try {
    const { data: reviews, error } = await supabase
      .from('ride_reviews')
      .select(`
        id, rating, review, created_at,
        rider:users!ride_reviews_rider_id_fkey(id, full_name, profile_pic)
      `)
      .eq('driver_id', driver_id)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    // Calculate average rating
    const avgRating = reviews.length > 0 ? (
      reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
    ).toFixed(2) : null;

    res.json({ average_rating: avgRating, reviews });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});


export default router;
