use image::{DynamicImage, Rgba, RgbaImage};
use std::path::PathBuf;

fn grayscale_at(image: &image::GrayImage, x: i32, y: i32) -> u8 {
    let width = image.width() as i32;
    let height = image.height() as i32;
    let clamped_x = x.clamp(0, width.saturating_sub(1));
    let clamped_y = y.clamp(0, height.saturating_sub(1));
    image.get_pixel(clamped_x as u32, clamped_y as u32)[0]
}

fn refine_marker_center(gray: &image::GrayImage, rough_center_x: f32, rough_center_y: f32, radius: f32) -> (f32, f32) {
    let search_radius = (radius * 0.24).max(2.0);
    let search_px = search_radius.ceil() as i32;
    let min_probe_radius = (radius * 0.82).max(2.0);
    let max_probe_radius = (radius * 1.18).max(min_probe_radius + 1.0);
    let inner_min_radius = (radius * 0.16).max(2.0);
    let inner_max_radius = (radius * 0.62).max(inner_min_radius + 1.0);
    let score_center = |x: f32, y: f32| -> f32 {
        let mut radii = Vec::with_capacity(48);
        let mut strength_sum = 0.0_f32;
        let mut antipodal_difference_sum = 0.0_f32;
        let mut antipodal_samples = 0.0_f32;
        for step in 0..48 {
            let theta = (step as f32 / 48.0) * std::f32::consts::TAU;
            let cos = theta.cos();
            let sin = theta.sin();
            let mut best_edge_strength = 0.0_f32;
            let mut best_edge_radius = radius;
            let mut probe_r = min_probe_radius;
            while probe_r <= max_probe_radius {
                let inner = grayscale_at(gray, (x + ((probe_r - 2.0) * cos)).round() as i32, (y + ((probe_r - 2.0) * sin)).round() as i32) as f32;
                let outer = grayscale_at(gray, (x + ((probe_r + 2.0) * cos)).round() as i32, (y + ((probe_r + 2.0) * sin)).round() as i32) as f32;
                let edge_strength = (outer - inner).max(0.0);
                if edge_strength > best_edge_strength {
                    best_edge_strength = edge_strength;
                    best_edge_radius = probe_r;
                }
                probe_r += 1.0;
            }
            radii.push(best_edge_radius);
            strength_sum += best_edge_strength;
            let mut symmetry_r = inner_min_radius;
            while symmetry_r <= inner_max_radius {
                let a = grayscale_at(gray, (x + (symmetry_r * cos)).round() as i32, (y + (symmetry_r * sin)).round() as i32) as f32;
                let b = grayscale_at(gray, (x - (symmetry_r * cos)).round() as i32, (y - (symmetry_r * sin)).round() as i32) as f32;
                antipodal_difference_sum += (a - b).abs();
                antipodal_samples += 1.0;
                symmetry_r += 2.0;
            }
        }
        let mean_radius = radii.iter().sum::<f32>() / radii.len() as f32;
        let variance = radii.iter().map(|v| (v - mean_radius).abs()).sum::<f32>() / radii.len() as f32;
        let mean_strength = strength_sum / radii.len() as f32;
        let antipodal_penalty = if antipodal_samples > 0.0 { antipodal_difference_sum / antipodal_samples } else { 255.0 };
        (mean_strength * 1.2) - (variance * 18.0) - (antipodal_penalty * 0.9)
    };
    let rough_score = score_center(rough_center_x, rough_center_y);
    let mut best = (rough_center_x, rough_center_y);
    let mut best_score = rough_score;
    for dy in -search_px..=search_px {
        for dx in -search_px..=search_px {
            let x = rough_center_x + dx as f32;
            let y = rough_center_y + dy as f32;
            let radial_penalty = (((dx * dx + dy * dy) as f32).sqrt() / search_radius.max(1.0)) * 2.4;
            let score = score_center(x, y) - radial_penalty;
            if score > best_score {
                best_score = score;
                best = (x, y);
            }
        }
    }
    let moved = ((best.0 - rough_center_x).powi(2) + (best.1 - rough_center_y).powi(2)).sqrt();
    let improvement = best_score - rough_score;
    if moved > radius * 0.08 || improvement < 4.0 {
        (rough_center_x, rough_center_y)
    } else {
        best
    }
}

fn stamp_cross(img: &mut RgbaImage, x: f32, y: f32, color: Rgba<u8>) {
    let cx = x.round() as i32;
    let cy = y.round() as i32;
    for dy in -8..=8 {
        let py = cy + dy;
        if py >= 0 && py < img.height() as i32 && cx >= 0 && cx < img.width() as i32 {
            img.put_pixel(cx as u32, py as u32, color);
        }
    }
    for dx in -8..=8 {
        let px = cx + dx;
        if cy >= 0 && cy < img.height() as i32 && px >= 0 && px < img.width() as i32 {
            img.put_pixel(px as u32, cy as u32, color);
        }
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("image path required");
    let src = PathBuf::from(&path);
    let decoded = image::open(&src).expect("open failed");
    let mut rgba = decoded.to_rgba8();
    let gray = decoded.to_luma8();

    // manual crop around the left marker in the supplied test image
    let crop_x = 2700_u32;
    let crop_y = 2200_u32;
    let crop_w = 700_u32;
    let crop_h = 700_u32;
    let crop = DynamicImage::ImageRgba8(rgba.clone()).crop_imm(crop_x, crop_y, crop_w, crop_h);
    let crop_gray = crop.to_luma8();

    let rough_center_x = 516.0_f32;
    let rough_center_y = 304.0_f32;
    let radius = 80.0_f32;
    let (refined_x, refined_y) = refine_marker_center(&crop_gray, rough_center_x, rough_center_y, radius);

    let mut crop_rgba = crop.to_rgba8();
    stamp_cross(&mut crop_rgba, rough_center_x, rough_center_y, Rgba([0, 255, 0, 255]));
    stamp_cross(&mut crop_rgba, refined_x, refined_y, Rgba([255, 128, 0, 255]));
    let out = PathBuf::from("marker-debug-output.png");
    crop_rgba.save(&out).expect("save failed");
    println!("saved {}", out.display());
    println!("rough=({}, {}) refined=({}, {})", rough_center_x, rough_center_y, refined_x, refined_y);
    let _ = (&gray, &mut rgba);
}
