import express from 'express';
import { supabase, requireAuth, optionalAuth } from '../supabase.js';
import multer from 'multer';
import path from 'path';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only images (jpeg, jpg, png) are allowed'));
  },
}).array('images', 10); // Allow up to 10 images

// Get all listings with optional filters
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
        *,
        profiles!listings_landlord_id_fkey (
          full_name,
          phone,
          user_type,
          email
        )
      `);

    // Apply filters
    if (location) query = query.ilike('location', `%${location}%`);
    if (property_type) query = query.eq('property_type', property_type);
    if (min_price) query = query.gte('price', parseInt(min_price));
    if (max_price) query = query.lte('price', parseInt(max_price));
    if (bedrooms) query = query.eq('bedrooms', parseInt(bedrooms));
    if (bathrooms) query = query.eq('bathrooms', parseInt(bathrooms));
    if (county) query = query.ilike('county', `%${county}%`);
    if (estate) query = query.ilike('estate', `%${estate}%`);
    if (landlord_name) query = query.ilike('landlord_name', `%${landlord_name}%`);

    // Apply is_available filter for non-owners
    if (!req.user) {
      query = query.eq('is_available', true);
    }

    query = query
      .order(sort, { ascending: order === 'asc' })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: listings, error, count } = await query;

    if (error) throw error;

    res.json({
      listings,
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// Search listings
router.post('/search', optionalAuth, async (req, res) => {
  try {
    const {
      query: searchQuery,
      filters = {},
      limit = 20,
      offset = 0,
    } = req.body;

    let query = supabase
      .from('listings')
      .select(`
        *,
        profiles!listings_landlord_id_fkey (
          full_name,
          phone,
          user_type,
          email
        )
      `);

    // Text search
    if (searchQuery) {
      query = query.or(
        `title.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%,location.ilike.%${searchQuery}%,landlord_name.ilike.%${searchQuery}%`
      );
    }

    // Apply filters
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        switch (key) {
          case 'property_type':
            if (Array.isArray(value)) {
              query = query.in('property_type', value);
            } else {
              query = query.eq('property_type', value);
            }
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
          case 'landlord_name':
            query = query.ilike(key, `%${value}%`);
            break;
          case 'amenities':
            if (Array.isArray(value) && value.length > 0) {
              query = query.contains('amenities', value);
            }
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
      total: count,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Error searching listings:', error);
    res.status(500).json({ error: 'Failed to search listings' });
  }
});

// Get single listing
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: listing, error } = await supabase
      .from('listings')
      .select(`
        *,
        profiles!listings_landlord_id_fkey (
          id,
          full_name,
          phone,
          user_type,
          email
        )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    const canView = listing.is_available || (req.user && req.user.id === listing.landlord_id);
    if (!canView) {
      return res.status(403).json({ error: 'Listing not available' });
    }

    res.json(listing);
  } catch (error) {
    console.error('Error fetching listing:', error);
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

// Create new listing
router.post('/', requireAuth, upload, async (req, res) => {
  try {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('user_type, full_name')
      .eq('id', req.user.id)
      .single();

    if (profileError) throw profileError;
    if (!profile || !['landlord', 'caretaker'].includes(profile.user_type)) {
      return res.status(403).json({ error: 'Only landlords and caretakers can create listings' });
    }

    let image_url = null;
    let images = [];
    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(async (file) => {
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 15)}${path.extname(file.originalname)}`;
        const { error: uploadError } = await supabase.storage
          .from('listing-images')
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
          });
        if (uploadError) throw uploadError;
        return supabase.storage.from('listing-images').getPublicUrl(fileName).data.publicUrl;
      });
      const uploadedUrls = await Promise.all(uploadPromises);
      image_url = uploadedUrls[0]; // First image as primary
      images = uploadedUrls.slice(1); // Remaining images
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

    const { data: listing, error } = await supabase
      .from('listings')
      .insert(listingData)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(listing);
  } catch (error) {
    console.error('Error creating listing:', error);
    res.status(500).json({ error: 'Failed to create listing', details: error.message });
  }
});

// Update listing
router.put('/:id', requireAuth, upload, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('landlord_id, image_url, images')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!listing || listing.landlord_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this listing' });
    }

    let image_url = listing.image_url;
    let images = req.body.existing_images ? JSON.parse(req.body.existing_images) : listing.images || [];
    const oldImagePaths = (listing.images || []).map(url => url.split('/').filter(Boolean).pop());

    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(async (file) => {
        const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 15)}${path.extname(file.originalname)}`;
        const { error: uploadError } = await supabase.storage
          .from('listing-images')
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
          });
        if (uploadError) throw uploadError;
        return supabase.storage.from('listing-images').getPublicUrl(fileName).data.publicUrl;
      });
      const uploadedUrls = await Promise.all(uploadPromises);
      image_url = uploadedUrls[0] || image_url; // Update primary image if new upload
      images = [...images, ...uploadedUrls.slice(1)]; // Append additional images
    }

    const newImagePaths = images.map(url => url.split('/').filter(Boolean).pop());
    const imagesToDelete = oldImagePaths.filter(path => !newImagePaths.includes(path));
    if (imagesToDelete.length > 0) {
      const { error: storageError } = await supabase.storage
        .from('listing-images')
        .remove(imagesToDelete);
      if (storageError) throw storageError;
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
      .select()
      .single();

    if (error) throw error;

    res.json(updatedListing);
  } catch (error) {
    console.error('Error updating listing:', error);
    res.status(500).json({ error: 'Failed to update listing', details: error.message });
  }
});

// Delete listing
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('landlord_id, image_url, images')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!listing || listing.landlord_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this listing' });
    }

    // Delete listing images
    const imagePaths = [
      ...(listing.image_url ? [listing.image_url.split('/').filter(Boolean).pop()] : []),
      ...(listing.images || []).map(url => url.split('/').filter(Boolean).pop()),
    ];
    if (imagePaths.length > 0) {
      const { error: storageError } = await supabase.storage
        .from('listing-images')
        .remove(imagePaths);
      if (storageError) throw storageError;
    }

    const { error } = await supabase
      .from('listings')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'Listing deleted successfully' });
  } catch (error) {
    console.error('Error deleting listing:', error);
    res.status(500).json({ error: 'Failed to delete listing', details: error.message });
  }
});

// Get landlord's listings
router.get('/landlord/my-listings', requireAuth, async (req, res) => {
  try {
    const { data: listings, error } = await supabase
      .from('listings')
      .select('*')
      .eq('landlord_id', req.user.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    res.json({ listings });
  } catch (error) {
    console.error('Error fetching landlord listings:', error);
    res.status(500).json({ error: 'Failed to fetch your listings', details: error.message });
  }
});

// Get all listings for a landlord by ID
router.get('/landlord/:landlordId', optionalAuth, async (req, res) => {
  try {
    const { landlordId } = req.params;
    const { data: listings, error } = await supabase
      .from('listings')
      .select('*')
      .eq('landlord_id', landlordId)
      .eq('is_available', true)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json({ listings });
  } catch (error) {
    console.error('Error fetching listings by landlord:', error);
    res.status(500).json({ error: 'Failed to fetch listings', details: error.message });
  }
});

export default router;