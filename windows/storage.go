package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const maxDataBytes = 32 << 20

type store struct {
	path string
	mu   sync.Mutex
}

type bootData struct {
	Data   json.RawMessage `json:"data,omitempty"`
	Notice string          `json:"notice,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func validateData(b []byte) error {
	if len(b) > maxDataBytes {
		return errors.New("коллекция превышает 32 МБ")
	}
	var root struct {
		App      string                     `json:"app"`
		Version  int                        `json:"version"`
		Decks    map[string]json.RawMessage `json:"decks"`
		Settings map[string]json.RawMessage `json:"settings"`
	}
	if json.Unmarshal(b, &root) != nil || root.App != "kartochki" || root.Version != 1 || root.Decks == nil || root.Settings == nil {
		return errors.New("некорректный файл коллекции")
	}
	total := 0
	for _, raw := range root.Decks {
		var d struct {
			Name  *string           `json:"name"`
			Cards []json.RawMessage `json:"cards"`
		}
		if json.Unmarshal(raw, &d) != nil || d.Name == nil || d.Cards == nil {
			return errors.New("некорректная колода")
		}
		total += len(d.Cards)
		if total > 100000 {
			return errors.New("слишком много карточек")
		}
		for _, rawCard := range d.Cards {
			var c struct {
				Front *string `json:"front"`
				Back  *string `json:"back"`
			}
			if json.Unmarshal(rawCard, &c) != nil || c.Front == nil || *c.Front == "" || c.Back == nil {
				return errors.New("некорректная карточка")
			}
		}
	}
	return validateFields(b)
}

func readData(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxDataBytes+1))
	if err != nil {
		return nil, err
	}
	return b, validateData(b)
}

func (s *store) load() bootData {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, primaryErr := readData(s.path)
	if primaryErr == nil {
		return bootData{Data: b}
	}
	b, backupErr := readData(s.path + ".bak")
	if backupErr == nil {
		return bootData{Data: b, Notice: "Коллекция восстановлена из резервной копии"}
	}
	if errors.Is(primaryErr, os.ErrNotExist) && errors.Is(backupErr, os.ErrNotExist) {
		return bootData{}
	}
	return bootData{Error: "Не удалось прочитать коллекцию и резервную копию. Файлы оставлены без изменений."}
}

func atomicWrite(path string, b []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".kartochki-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = replaceFile(name, path); err != nil {
		return err
	}
	return nil
}

func (s *store) save(b []byte) error {
	if err := validateData(b); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := readData(s.path)
	if err == nil {
		if err = atomicWrite(s.path+".bak", previous); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {

		target := fmt.Sprintf("%s.corrupt-%d", s.path, time.Now().UnixNano())
		if err = copyPrivate(s.path, target); err != nil {
			return err
		}

	}
	return atomicWrite(s.path, b)
}

// Match the frontend schema so a damaged primary never replaces a healthy backup.
func validateFields(b []byte) error {
	var root map[string]any
	if json.Unmarshal(b, &root) != nil {
		return errors.New("некорректный JSON")
	}
	bad := errors.New("некорректные настройки или прогресс")
	validText := func(v any) bool { s, ok := v.(string); return ok && len([]rune(s)) <= 200000 }
	checkNumber := func(m map[string]any, k string, min, max float64, integer bool) bool {
		v, exists := m[k]
		if !exists {
			return true
		}
		n, ok := v.(float64)
		return ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= min && n <= max && (!integer || math.Trunc(n) == n)
	}
	settings := root["settings"].(map[string]any)
	if theme, ok := settings["theme"]; ok && theme != "light" && theme != "dark" {
		return bad
	}
	if !checkNumber(settings, "newPerDay", 0, 100000, true) {
		return bad
	}
	date := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	deckIDs := map[string]bool{}
	for _, raw := range root["decks"].(map[string]any) {
		d := raw.(map[string]any)
		if !validText(d["name"]) || !checkNumber(d, "created", 0, 8640000000000000, false) {
			return bad
		}
		if id, ok := d["id"].(string); ok {
			if deckIDs[id] {
				return bad
			}
			deckIDs[id] = true
		}
		if v, ok := d["newLog"]; ok && v != nil {
			log, ok := v.(map[string]any)
			if !ok {
				return bad
			}
			day, ok := log["date"].(string)
			if !ok || !date.MatchString(day) || !checkNumber(log, "count", 0, 1e12, false) {
				return bad
			}
		}
		ids := map[string]bool{}
		for _, raw := range d["cards"].([]any) {
			c := raw.(map[string]any)
			if !validText(c["front"]) || strings.TrimSpace(c["front"].(string)) == "" || !validText(c["back"]) {
				return bad
			}
			if id, ok := c["id"].(string); ok {
				if ids[id] {
					return bad
				}
				ids[id] = true
			}
			if state, ok := c["state"]; ok && state != "new" && state != "learn" && state != "review" {
				return bad
			}
			if freq, ok := c["freq"]; ok && freq != 0.25 && freq != 0.5 && freq != float64(1) && freq != float64(2) && freq != float64(4) {
				return bad
			}
			for _, k := range []string{"due", "last"} {
				if !checkNumber(c, k, 0, 8640000000000000, false) {
					return bad
				}
			}
			for _, k := range []string{"interval", "reps", "lapses", "step"} {
				if !checkNumber(c, k, 0, 1e12, false) {
					return bad
				}
			}
			if !checkNumber(c, "ease", 1.3, 1000, false) {
				return bad
			}
		}
	}
	return nil
}

func copyPrivate(source, target string) error {
	src, err := os.Open(source)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, src)
	if err == nil {
		err = dst.Sync()
	}
	closeErr := dst.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(target)
	}
	return err
}
