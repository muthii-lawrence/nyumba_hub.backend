import express from 'express';
import { supabase, requireAuth } from '../supabase.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

// Get user's favorites
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data: favorites, error } = await supabase
      .from('favorites')
      .select(`
        id, created_at, listing_id,
        listings (
          id, title, price, location, is_available, image_url
        )
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ favorites: favorites.filter((f) => f.listings?.is_available) });
  } catch (error) {
    console.error('Error fetching favorites:', error.message);
    res.status(500).json({ error: 'Failed to fetch favorites', code: 'FETCH_ERROR' });
  }
});

// Add to favorites
router.post('/', requireAuth, limiter, async (req, res) => {
  try {
    const { listing_id } = req.body;

    if (!listing_id) {
      return res.status(400).json({ error: 'Listing ID is required', code: 'INVALID_INPUT' });
    }

    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('id, is_available')
      .eq('id', listing_id)
      .single();

    if (listingError || !listing) {
      return res.status(404).json({ error: 'Listing not found', code: 'NOT_FOUND' });
    }

    if (!listing.is_available) {
      return res.status(400).json({ error: 'Cannot favorite unavailable listing', code: 'UNAVAILABLE' });
    }

    const { data: favorite, error } = await supabase
      .from('favorites')
      .insert({ user_id: req.user.id, listing_id })
      .select('id, listing_id, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Listing already in favorites', code: 'DUPLICATE' });
      }
      throw error;
    }

    res.status(201).json(favorite);
  } catch (error) {
    console.error('Error adding to favorites:', error.message);
    res.status(500).json({ error: 'Failed to add to favorites', code: 'INSERT_ERROR' });
  }
});

// Remove from favorites
router.delete('/:listingId', requireAuth, limiter, async (req, res) => {
  try {
    const { listingId } = req.params;

    const { error } = await supabase
      .from('favorites')
      .delete()
      .eq('user_id', req.user.id)
      .eq('listing_id', listingId);

    if (error) throw error;

    res.json({ message: 'Removed from favorites' });
  } catch (error) {
    console.error('Error removing from favorites:', error.message);
    res.status(500).json({ error: 'Failed to remove from favorites', code: 'DELETE_ERROR' });
  }
});

// Check if listing is favorited
router.get('/check/:listingId', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params;

    const { data: favorite, error } = await supabase
      .from('favorites')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('listing_id', listingId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json({ isFavorited: !!favorite });
  } catch (error) {
    console.error('Error checking favorite status:', error.message);
    res.status(500).json({ error: 'Failed to check favorite status', code: 'CHECK_ERROR' });
  }
});

export default router;