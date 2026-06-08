-- Drop the unique constraint on phone/phone_number so siblings can share a parent phone number.
-- The bulk import flow now handles duplicate-phone detection as a non-blocking warning.

ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_phone_unique;
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_phone_number_unique;
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_phone_key;
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_phone_number_key;
