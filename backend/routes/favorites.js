import express from 'express'
import { supabase, requireAuth } from '../supabase.js'

const router = express.Router()

// Get user's favorites
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data: favorites, error } = await supabase
      .from('favorites')
      .select(`
        *,
        listings (
          *,
          profiles!listings_landlord_id_fkey (
            full_name,
            phone
          )
        )
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ favorites })
  } catch (error) {
    console.error('Error fetching favorites:', error)
    res.status(500).json({ error: 'Failed to fetch favorites' })
  }
})

// Add to favorites
router.post('/', requireAuth, async (req, res) => {
  try {
    const { listing_id } = req.body

    if (!listing_id) {
      return res.status(400).json({ error: 'Listing ID is required' })
    }

    // Check if listing exists and is available
    const { data: listing } = await supabase
      .from('listings')
      .select('id, is_available')
      .eq('id', listing_id)
      .single()

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' })
    }

    if (!listing.is_available) {
      return res.status(400).json({ error: 'Cannot favorite unavailable listing' })
    }

    const { data: favorite, error } = await supabase
      .from('favorites')
      .insert({
        user_id: req.user.id,
        listing_id: listing_id
      })
      .select()
      .single()

    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        return res.status(400).json({ error: 'Listing already in favorites' })
      }
      throw error
    }

    res.status(201).json(favorite)
  } catch (error) {
    console.error('Error adding to favorites:', error)
    res.status(500).json({ error: 'Failed to add to favorites' })
  }
})

// Remove from favorites
router.delete('/:listingId', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params

    const { error } = await supabase
      .from('favorites')
      .delete()
      .eq('user_id', req.user.id)
      .eq('listing_id', listingId)

    if (error) throw error

    res.json({ message: 'Removed from favorites' })
  } catch (error) {
    console.error('Error removing from favorites:', error)
    res.status(500).json({ error: 'Failed to remove from favorites' })
  }
})

// Check if listing is favorited
router.get('/check/:listingId', requireAuth, async (req, res) => {
  try {
    const { listingId } = req.params

    const { data: favorite, error } = await supabase
      .from('favorites')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('listing_id', listingId)
      .single()

    if (error && error.code !== 'PGRST116') throw error

    res.json({ isFavorited: !!favorite })
  } catch (error) {
    console.error('Error checking favorite status:', error)
    res.status(500).json({ error: 'Failed to check favorite status' })
  }
})

export default router