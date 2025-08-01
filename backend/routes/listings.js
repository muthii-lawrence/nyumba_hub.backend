import express from 'express';
import { supabase, requireAuth, optionalAuth } from '../supabase.js';
import multer from 'multer';
import path from 'path';
import compression from 'compression';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per window
  standardHeaders: true,
  legacyHeaders: false,
});

// Multer config
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
    cb(new Error('Only images (jpeg, jpg, png) are allowed'));
  },
}).array('images', 10);

// Compression
router.use(compression());

// Get all listings
router.get('/', optionalAuth, async (req, res) => {
  try {
    const {
      limit = 20,
      offset = 0,
      sort = 'updated_at',
      order = 'desc',
      location,
      property_type,
      min_price,
      max_price,
      bedrooms,
      bathrooms,
      county,
      estate,
      landlord_name,
    } = req.query;

    let query = supabase
      .from('listings')
      .select(`
        id, title, price, location, property_type, bedrooms, bathrooms, is_available, image_url
      `)
      .eq('is_available', true);

    if (location) query = query.ilike('location', `%${location}%`);
    if (property_type) query = query.eq('property_type', property_type);
    if (min_price) query = query.gte('price', parseInt(min_price));
    if (max_price) query = query.lte('price', parseInt(max_price));
    if (bedrooms) query = query.eq('bedrooms', parseInt(bedrooms));
    if (bathrooms) query = query.eq('bathrooms', parseInt(bathrooms));
    if (county) query = query.ilike('county', `%${county}%`);
    if (estate) query = query.ilike('estate', `%${estate}%`);
    if (landlord_name) query = query.ilike('landlord_name', `%${landlord_name}%`);

    const { data: listings, error, count } = await query
      .order(sort, { ascending: order === 'asc' })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      listings,
      total: count || listings.length,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Error fetching listings:', error.message, error);
    res.status(500).json({ error: 'Failed to fetch listings', code: 'FETCH_ERROR' });
  }
});

// Search listings
router.post('/search', optionalAuth, async (req, res) => {
  try {
    const { query: searchQuery, filters = {}, limit = 20, offset = 0 } = req.body;

    let query = supabase
      .from('listings')
      .select(`
        id, title, price, location, property_type, bedrooms, bathrooms, is_available, image_url
      `)
      .eq('is_available', true);

    if (searchQuery) {
      query = query.or(
        `title.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%,location.ilike.%${searchQuery}%`
      );
    }

    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        switch (key) {
          case 'property_type':
            if (Array.isArray(value)) query = query.in('property_type', value);
            else query = query.eq('property_type', value);
            break;
          case 'min_price':
            query = query.gte('price', parseInt(value));
            break;
          case 'max_price':
            query = query.lte('price', parseInt(value));
            break;
          case 'bedrooms':
            query = query.eq('bedrooms', parseInt(value));
            break;
          case 'bathrooms':
            query = query.eq('bathrooms', parseInt(value));
            break;
          case 'location':
          case 'county':
          case 'estate':
            query = query.ilike(key, `%${value}%`);
            break;
          case 'amenities':
            if (Array.isArray(value) && value.length > 0) query = query.contains('amenities', value);
            break;
          case 'furnishing_status':
            query = query.eq('furnishing_status', value);
            break;
          case 'parking':
          case 'garden':
          case 'balcony':
          case 'own_compound':
          case 'electricity':
          case 'internet':
            query = query.eq(key, value === 'true' || value === true);
            break;
        }
      }
    });

    const { data: listings, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      listings,
      total: count || listings.length,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Error searching listings:', error.message, error);
    res.status(500).json({ error: 'Failed to search listings', code: 'SEARCH_ERROR' });
  }
});

// Get single listing
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: listing, error } = await supabase
      .from('listings')
      .select(`
        id, title, description, price, property_type, bedrooms, bathrooms, location, county, estate,
        amenities, furnishing_status, parking, garden, balcony, own_compound, electricity, internet,
        is_available, image_url, images, landlord_id,
        profiles!listings_landlord_id_fkey (id, full_name, phone, user_type, email)
      `)
      .eq('id', id)
      .single();

    if (error || !listing) {
      return res.status(404).json({ error: 'Listing not found', code: 'NOT_FOUND' });
    }

    const canView = listing.is_available || (req.user && req.user.id === listing.landlord_id);
    if (!canView) {
      return res.status(403).json({ error: 'Listing not available', code: 'UNAVAILABLE' });
    }

    res.json(listing);
  } catch (error) {
    console.error('Error fetching listing:', error.message, error);
    res.status(500).json({ error: 'Failed to fetch listing', code: 'FETCH_ERROR' });
  }
});

// Create new listing
router.post('/', requireAuth, limiter, upload, async (req, res) => {
  try {
    console.log('POST /api/listings received:', { body: req.body, files: req.files, user: req.user });
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('user_type, full_name')
      .eq('id', req.user.id)
      .single();

    if (profileError) {
      console.error('Profile fetch error:', profileError);
      return res.status(500).json({ error: 'Failed to fetch user profile', code: 'PROFILE_FETCH_ERROR' });
    }

    if (!profile || !['landlord', 'caretaker'].includes(profile.user_type)) {
      console.error('Unauthorized user type:', profile?.user_type);
      return res.status(403).json({ error: 'Only landlords and caretakers can create listings', code: 'UNAUTHORIZED' });
    }

    let image_url = null;
    let images = [];
    if (req.files?.length > 0) {
      const uploadPromises = req.files.map(async (file) => {
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 15)}${path.extname(file.originalname)}`;
        const { error: uploadError } = await supabase.storage
          .from('listing-images')
          .upload(fileName, file.buffer, { contentType: file.mimetype });
        if (uploadError) {
          console.error('Storage upload error:', uploadError);
          throw uploadError;
        }
        return supabase.storage.from('listing-images').getPublicUrl(fileName).data.publicUrl;
      });
      const uploadedUrls = await Promise.all(uploadPromises);
      image_url = uploadedUrls[0];
      images = uploadedUrls.slice(1);
    }

    const listingData = {
      title: req.body.title,
      description: req.body.description,
      price: parseInt(req.body.price) || 0,
      property_type: req.body.property_type,
      bedrooms: parseInt(req.body.bedrooms) || 0,
      bathrooms: parseInt(req.body.bathrooms) || 0,
      location: req.body.location,
      county: req.body.county,
      estate: req.body.estate,
      landlord_name: req.body.landlord_name || profile.full_name,
      amenities: JSON.parse(req.body.amenities || '[]'),
      furnishing_status: req.body.furnishing_status,
      parking: req.body.parking === 'true',
      garden: req.body.garden === 'true',
      balcony: req.body.balcony === 'true',
      own_compound: req.body.own_compound === 'true',
      electricity: req.body.electricity === 'true',
      internet: req.body.internet === 'true',
      is_available: req.body.is_available === 'true',
      landlord_id: req.user.id,
      image_url,
      images,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    console.log('Inserting listing:', listingData);
    const { data: listing, error } = await supabase
      .from('listings')
      .insert(listingData)
      .select('id, title, price, location, is_available, image_url')
      .single();

    if (error) {
      console.error('Listing insert error:', error);
      throw error;
    }

    res.status(201).json(listing);
  } catch (error) {
    console.error('Error creating listing:', error.message, error);
    res.status(500).json({ error: 'Failed to create listing', code: 'INSERT_ERROR', details: error.message });
  }
});

// Update listing
router.put('/:id', requireAuth, limiter, upload, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('landlord_id, image_url, images')
      .eq('id', id)
      .single();

    if (fetchError || !listing || listing.landlord_id !== req.user.id) {
      console.error('Fetch or authorization error:', fetchError, listing?.landlord_id, req.user.id);
      return res.status(403).json({ error: 'Not authorized to update this listing', code: 'UNAUTHORIZED' });
    }

    let image_url = listing.image_url;
    let images = req.body.existing_images ? JSON.parse(req.body.existing_images) : listing.images || [];
    const oldImagePaths = (listing.images || []).map((url) => url.split('/').pop());

    if (req.files?.length > 0) {
      const uploadPromises = req.files.map(async (file) => {
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 15)}${path.extname(file.originalname)}`;
        const { error: uploadError } = await supabase.storage
          .from('listing-images')
          .upload(fileName, file.buffer, { contentType: file.mimetype });
        if (uploadError) {
          console.error('Storage update error:', uploadError);
          throw uploadError;
        }
        return supabase.storage.from('listing-images').getPublicUrl(fileName).data.publicUrl;
      });
      const uploadedUrls = await Promise.all(uploadPromises);
      image_url = uploadedUrls[0] || image_url;
      images = [...images, ...uploadedUrls.slice(1)];
    }

    const newImagePaths = images.map((url) => url.split('/').pop());
    const imagesToDelete = oldImagePaths.filter((path) => !newImagePaths.includes(path));
    if (imagesToDelete.length > 0) {
      await supabase.storage.from('listing-images').remove(imagesToDelete);
    }

    const updateData = {
      title: req.body.title,
      description: req.body.description,
      price: parseInt(req.body.price) || 0,
      property_type: req.body.property_type,
      bedrooms: parseInt(req.body.bedrooms) || 0,
      bathrooms: parseInt(req.body.bathrooms) || 0,
      location: req.body.location,
      county: req.body.county,
      estate: req.body.estate,
      landlord_name: req.body.landlord_name,
      amenities: JSON.parse(req.body.amenities || '[]'),
      furnishing_status: req.body.furnishing_status,
      parking: req.body.parking === 'true',
      garden: req.body.garden === 'true',
      balcony: req.body.balcony === 'true',
      own_compound: req.body.own_compound === 'true',
      electricity: req.body.electricity === 'true',
      internet: req.body.internet === 'true',
      is_available: req.body.is_available === 'true',
      image_url,
      images,
      updated_at: new Date().toISOString(),
    };

    const { data: updatedListing, error } = await supabase
      .from('listings')
      .update(updateData)
      .eq('id', id)
      .select('id, title, price, location, is_available, image_url')
      .single();

    if (error) {
      console.error('Listing update error:', error);
      throw error;
    }

    res.json(updatedListing);
  } catch (error) {
    console.error('Error updating listing:', error.message, error);
    res.status(500).json({ error: 'Failed to update listing', code: 'UPDATE_ERROR', details: error.message });
  }
});

// Delete listing
router.delete('/:id', requireAuth, limiter, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('landlord_id, image_url, images')
      .eq('id', id)
      .single();

    if (fetchError || !listing || listing.landlord_id !== req.user.id) {
      console.error('Fetch or authorization error:', fetchError, listing?.landlord_id, req.user.id);
      return res.status(403).json({ error: 'Not authorized to delete this listing', code: 'UNAUTHORIZED' });
    }

    const imagePaths = [
      ...(listing.image_url ? [listing.image_url.split('/').pop()] : []),
      ...(listing.images || []).map((url) => url.split('/').pop()),
    ];
    if (imagePaths.length > 0) {
      await supabase.storage.from('listing-images').remove(imagePaths);
    }

    const { error } = await supabase.from('listings').delete().eq('id', id);

    if (error) {
      console.error('Listing delete error:', error);
      throw error;
    }

    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting listing:', error.message, error);
    res.status(500).json({ error: 'Failed to delete listing', code: 'DELETE_ERROR', details: error.message });
  }
});

// Get landlord's listings
router.get('/landlord/my-listings', requireAuth, async (req, res) => {
  try {
    const { data: listings, error } = await supabase
      .from('listings')
      .select('id, title, price, location, is_available, image_url')
      .eq('landlord_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ listings });
  } catch (error) {
    console.error('Error fetching landlord listings:', error.message, error);
    res.status(500).json({ error: 'Failed to fetch your listings', code: 'FETCH_ERROR' });
  }
});

// Get all listings for a landlord by ID
router.get('/landlord/:landlordId', optionalAuth, async (req, res) => {
  try {
    const { landlordId } = req.params;
    const { data: listings, error } = await supabase
      .from('listings')
      .select('id, title, price, location, is_available, image_url')
      .eq('landlord_id', landlordId)
      .eq('is_available', true)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ listings });
  } catch (error) {
    console.error('Error fetching listings by landlord:', error.message, error);
    res.status(500).json({ error: 'Failed to fetch listings', code: 'FETCH_ERROR' });
  }
});

export default router;