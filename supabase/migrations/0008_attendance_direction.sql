-- 0008_attendance_direction.sql — allow both 'in' (face scan check-in) and 'out' (exit button) in attendance.
-- Single-camera gate uses 'in' for face entry scans; physical exit button logs 'out'.

alter table attendance drop constraint if exists attendance_direction_check;
alter table attendance add constraint attendance_direction_check check (direction in ('in', 'out'));
