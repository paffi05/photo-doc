import cv2, json, importlib.util
spec = importlib.util.spec_from_file_location('det', r'c:\Users\Leonhardt\Desktop\Projekte\photo-doc\src-tauri\python\detect_glasses_markers.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
images = [
    ('heyer', r'R:\Fotos\Patientenfotos Leo\Heyer, Isabella\2024-01-11 Portrait\IMG_6259.JPG', 'marker-control-overlay-heyer.png'),
    ('wittemann', r'R:\Fotos\Patientenfotos Leo\Wittemann, Nicole\2025-10-23 Portait\IMG_8646.JPG', 'marker-control-overlay-wittemann.png'),
]
for name, image_path, out_name in images:
    result = mod.detect_markers(image_path)
    print(name, json.dumps(result))
    img = cv2.imread(image_path, cv2.IMREAD_COLOR)
    for idx, key in enumerate(['left_marker_center', 'right_marker_center']):
        pt = result.get(key)
        if not pt:
            continue
        x = int(round(pt['x']))
        y = int(round(pt['y']))
        cv2.circle(img, (x, y), 26, (0, 140, 255), 3)
        cv2.circle(img, (x, y), 5, (0, 140, 255), -1)
        cv2.putText(img, f'{idx+1}', (x + 18, y - 18), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2, cv2.LINE_AA)
    left = result.get('left_marker_center')
    right = result.get('right_marker_center')
    if left and right:
        cv2.line(img, (int(round(left['x'])), int(round(left['y']))), (int(round(right['x'])), int(round(right['y']))), (0, 180, 255), 2, cv2.LINE_AA)
    cv2.imwrite(out_name, img)
