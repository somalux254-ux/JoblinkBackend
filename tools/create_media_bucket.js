const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const MEDIA_BUCKET = 'media_files';

async function main() {
  if (!SUPABASE_URL) {
    console.error('Missing Supabase URL. Set SUPABASE_URL or REACT_APP_SUPABASE_URL in your environment.');
    process.exit(1);
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing Supabase service role key. Set SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE in your environment.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      console.error('Failed to list Supabase storage buckets:', listError.message || listError);
      process.exit(1);
    }

    const existingBucket = (buckets || []).find((bucket) => bucket.name === MEDIA_BUCKET);
    if (existingBucket) {
      console.log(`Bucket already exists: ${MEDIA_BUCKET}`);
      if (!existingBucket.public) {
        console.log(`Bucket ${MEDIA_BUCKET} is not public. Updating public access...`);
        const { data: updatedBucket, error: updateError } = await supabase.storage.updateBucket(MEDIA_BUCKET, { public: true });
        if (updateError) {
          console.error('Failed to update Supabase storage bucket visibility:', updateError.message || updateError);
          process.exit(1);
        }
        console.log(`Updated bucket ${MEDIA_BUCKET} to public access:`, updatedBucket.public);
      }
      process.exit(0);
    }

    const { data, error } = await supabase.storage.createBucket(MEDIA_BUCKET, { public: true });
    if (error) {
      console.error('Failed to create Supabase storage bucket:', error.message || error);
      process.exit(1);
    }

    console.log(`Created Supabase storage bucket: ${data.name}`);
    console.log('Bucket public access:', data.public);
    process.exit(0);
  } catch (err) {
    console.error('Unexpected error creating Supabase bucket:', err.message || err);
    process.exit(1);
  }
}

main();
